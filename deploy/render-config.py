#!/usr/bin/env python3
import argparse
import math
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

import yaml

ENV_KEYS = {
    "web_url": "CAP_URL",
    "s3_public_url": "S3_PUBLIC_URL",
    "chrome_extension_id": "CAP_CHROME_EXTENSION_ID",
    "allowed_signup_domains": "CAP_ALLOWED_SIGNUP_DOMAINS",
    "resend_from_domain": "RESEND_FROM_DOMAIN",
    "ai_provider": "AI_PROVIDER",
    "web_port": "CAP_PORT",
    "s3_port": "MINIO_PORT",
    "s3_console_port": "MINIO_CONSOLE_PORT",
    "origin_port": "ORIGIN_PORT",
    "web_memory": "CAP_WEB_MEMORY",
    "web_cpus": "CAP_WEB_CPUS",
    "origin_memory": "ORIGIN_MEMORY",
    "origin_cpus": "ORIGIN_CPUS",
    "origin_warm_ttl_s": "ORIGIN_WARM_TTL_S",
    "origin_max_keep_ranges": "ORIGIN_MAX_KEEP_RANGES",
    "transcode_threads": "MEDIA_TRANSCODE_THREADS",
}
PATH_KEYS = "compose_file compose_env_file web_env_file origin_env_file workflow_data".split()
WORKER_KEYS = "checkout env_file temp_dir bun path s3_internal_url origin_internal_url web_container mysql_container minio_container network s3_policy poll_ms".split()
SERVICES = "cap-web media-server instant-finish-origin mysql minio minio-setup".split()


def require_keys(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError(f"{label}: required keys are {', '.join(keys)}")


def text(value, label, empty=False):
    if not isinstance(value, str) or (not value and not empty) or any(c in value for c in "\r\n\0'$\\"):
        raise ValueError(f"{label}: expected a single-line literal string")


def url(value, label):
    text(value, label)
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{label}: expected an HTTP(S) URL without credentials, query or fragment")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError(f"{label}: invalid port")


def load_config(filename):
    filename = Path(filename).resolve()
    config = yaml.safe_load(filename.read_text())
    require_keys(config, [*ENV_KEYS, "images", "paths", "worker"], "config")
    require_keys(config["images"], SERVICES, "images")
    require_keys(config["paths"], PATH_KEYS, "paths")
    require_keys(config["worker"], WORKER_KEYS, "worker")
    for key, value in config.items():
        if key.endswith("_port") or key in {"origin_warm_ttl_s", "origin_max_keep_ranges", "transcode_threads"}:
            if type(value) is not int or value < 1 or (key.endswith("_port") and value > 65535):
                raise ValueError(f"{key}: expected a positive integer within range")
        elif key.endswith("_cpus"):
            if type(value) not in {int, float} or not math.isfinite(value) or value <= 0:
                raise ValueError(f"{key}: expected a positive CPU limit")
        elif key.endswith("_memory"):
            text(value, key)
            if not re.fullmatch(r"[1-9][0-9]*[bkmgBKMG]?", value):
                raise ValueError(f"{key}: invalid memory limit")
        elif key.endswith("_url"):
            url(value, key)
        elif key not in {"images", "paths", "worker"}:
            text(value, key, empty=True)
    extension = config["chrome_extension_id"]
    if extension and not re.fullmatch(r"[a-p]{32}", extension):
        raise ValueError("chrome_extension_id: expected 32 letters a-p or empty")
    domains = config["allowed_signup_domains"]
    if domains and not all(re.fullmatch(r"[A-Za-z0-9.-]+", part) for part in domains.split(",")):
        raise ValueError("allowed_signup_domains: expected comma-separated domain names")
    for service, image in config["images"].items():
        text(image, f"images.{service}")
        if not re.fullmatch(r"[A-Za-z0-9./:_@-]+", image):
            raise ValueError(f"images.{service}: invalid image reference")
    for key in PATH_KEYS:
        text(config["paths"][key], f"paths.{key}")
        config["paths"][key] = str((filename.parent / config["paths"][key]).resolve())
    for key in WORKER_KEYS:
        value = config["worker"][key]
        if key == "poll_ms":
            if type(value) is not int or not 1 <= value <= 2000:
                raise ValueError("worker.poll_ms: expected 1..2000")
        elif key.endswith("_url"):
            url(value, f"worker.{key}")
        else:
            text(value, f"worker.{key}")
            if key in {"checkout", "env_file", "temp_dir", "bun"}:
                config["worker"][key] = str((filename.parent / value).resolve())
    return config


def private_write(path, content):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def render(config):
    directory = Path(config["paths"]["compose_file"]).parent
    if not Path(config["paths"]["compose_file"]).is_file():
        raise ValueError("paths.compose_file: compose file does not exist")
    environment = "".join(f"{variable}='{config[key]}'\n" for key, variable in sorted(ENV_KEYS.items()))
    paths = config["paths"]
    services = {name: {"image": config["images"][name]} for name in SERVICES}
    services["cap-web"].update({
        "env_file": [paths["web_env_file"]],
        "volumes": [{"type": "bind", "source": paths["workflow_data"], "target": "/app/apps/web/.workflow-data", "bind": {"create_host_path": True}}],
    })
    services["instant-finish-origin"]["env_file"] = [paths["origin_env_file"]]
    override = yaml.safe_dump({"services": services}, sort_keys=True)
    private_write(directory / ".env.deploy", environment)
    private_write(directory / "docker-compose.override.yml", override)


def self_check():
    import copy

    example = Path(__file__).with_name("config.example.yaml")
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        config = load_config(example)
        (root / "docker-compose.yml").touch()
        config["paths"]["compose_file"] = str(root / "docker-compose.yml")
        render(config)
        files = [root / ".env.deploy", root / "docker-compose.override.yml"]
        before = [p.read_bytes() for p in files]
        render(config)
        assert before == [p.read_bytes() for p in files]
        assert all(p.stat().st_mode & 0o777 == 0o600 for p in files)
        override = yaml.safe_load(files[1].read_text())
        assert override["services"]["cap-web"]["env_file"] == [config["paths"]["web_env_file"]]
        assert override["services"]["cap-web"]["volumes"][0]["source"] == config["paths"]["workflow_data"]
        for key, value in [("web_url", "https://user:pass@example.com"), ("web_url", "bad\nvalue"), ("web_port", 0), ("web_cpus", float("nan")), ("chrome_extension_id", "invalid")]:
            bad = copy.deepcopy(yaml.safe_load(example.read_text()))
            bad[key] = value
            candidate = root / "invalid.yaml"
            candidate.write_text(yaml.safe_dump(bad))
            try:
                load_config(candidate)
            except ValueError:
                pass
            else:
                raise AssertionError(f"accepted invalid {key}")
        assert all(value.startswith("/") for value in config["paths"].values())
    print("renderer self-check passed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("config", nargs="?")
    parser.add_argument("--compose-file", type=Path)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
    elif args.config:
        try:
            config = load_config(args.config)
            if args.compose_file:
                config["paths"]["compose_file"] = str(args.compose_file.resolve())
            render(config)
        except (ValueError, OSError, yaml.YAMLError) as error:
            parser.exit(1, f"Configuration failed: {error.__class__.__name__}; check required keys, values and paths\n")
    else:
        parser.error("provide a config YAML path or --self-check")


if __name__ == "__main__":
    main()
