#!/usr/bin/env python3
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

load_config = runpy.run_path(str(Path(__file__).resolve().parents[1] / "render-config.py"))["load_config"]


def main():
    if sys.argv[1:] == ["--self-check"]:
        self_check()
        return
    if len(sys.argv) != 2:
        raise SystemExit("Usage: launch.py CONFIG.yaml")
    config = load_config(sys.argv[1])
    worker = config["worker"]
    origin = dict(
        line.split("=", 1)
        for line in Path(worker["env_file"]).read_text().splitlines()
        if line and not line.startswith("#") and "=" in line
    )
    names = [worker[key] for key in ["web_container", "mysql_container", "minio_container"]]
    containers = json.loads(subprocess.check_output(["docker", "inspect", *names], stderr=subprocess.PIPE))
    items = {item["Name"].removeprefix("/"): item for item in containers}
    web = dict(value.split("=", 1) for value in items[names[0]]["Config"]["Env"] if "=" in value)
    if web.get("CAP_REVISION_WORKER_MODE") != "external":
        raise ValueError("web runtime must use CAP_REVISION_WORKER_MODE=external")
    env = dict(os.environ)
    env.update(web)
    env.update(origin)
    mysql_ip = items[names[1]]["NetworkSettings"]["Networks"][worker["network"]]["IPAddress"]
    env["DATABASE_URL"] = env["DATABASE_URL"].replace("@mysql:", "@" + mysql_ip + ":")
    minio = dict(value.split("=", 1) for value in items[names[2]]["Config"]["Env"] if "=" in value)
    for key in ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]:
        env[key] = minio[key]
    env["S3_INTERNAL_ENDPOINT"] = worker["s3_internal_url"]
    env["CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL"] = worker["origin_internal_url"]
    env["CAP_INSTANT_FINISH_ORIGIN_URL"] = config["web_url"]
    env["CAP_REVISION_WORKER_MODE"] = "external"
    env["CAP_INSTANT_FINISH_OWNERS"] = web.get("CAP_INSTANT_FINISH_OWNERS", "")
    env["ORIGIN_S3_POLICY"] = worker["s3_policy"]
    env["TMPDIR"] = worker["temp_dir"]
    Path(env["TMPDIR"]).mkdir(exist_ok=True, mode=0o700)
    env["PATH"] = worker["path"]
    env["CAP_WORKER_POLL_MS"] = str(worker["poll_ms"])
    program = '''
const {db}=await import("@cap/database");
const {httpOriginClient}=await import("./lib/revision-publication-origin.ts");
const {startRevisionReadbackWorker}=await import("./lib/revision-publication.ts");
const {reconcileOriginReadPolicy}=await import("./lib/instant-finish-source-relocate.ts");
const database=db();
const worker=startRevisionReadbackWorker({database,origin:httpOriginClient(),pollMs:Number(process.env.CAP_WORKER_POLL_MS),onTick:async()=>{await reconcileOriginReadPolicy(database);}});
console.log("CAP_EXTERNAL_REVISION_WORKER_STARTED");
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>{worker.stop();process.exit(0);});
'''
    os.chdir(Path(worker["checkout"]) / "apps/web")
    os.execve(worker["bun"], ["bun", "--conditions=react-server", "-e", program], env)


def self_check():
    from unittest.mock import patch

    config = load_config(Path(__file__).resolve().parents[1] / "config.example.yaml")
    worker = config["worker"]
    containers = [
        {"Name": "/" + worker["web_container"], "Config": {"Env": ["DATABASE_URL=mysql://cap:test-password@mysql:3306/cap", "CAP_REVISION_WORKER_MODE=external", "CAP_INSTANT_FINISH_OWNERS=test-owner"]}},
        {"Name": "/" + worker["mysql_container"], "NetworkSettings": {"Networks": {worker["network"]: {"IPAddress": "172.18.0.2"}}}},
        {"Name": "/" + worker["minio_container"], "Config": {"Env": ["MINIO_ROOT_USER=test-admin", "MINIO_ROOT_PASSWORD=test-password"]}},
    ]
    with (
        patch.dict(main.__globals__, {"load_config": lambda _: config}),
        patch.object(sys, "argv", ["launch.py", "config.yaml"]),
        patch.dict(os.environ, {}, clear=True),
        patch.object(Path, "read_text", return_value="REVISION_ORIGIN_SERVICE_SECRET=test-secret\n"),
        patch.object(Path, "mkdir") as mkdir,
        patch.object(subprocess, "check_output", return_value=json.dumps(containers).encode()) as inspect,
        patch.object(os, "chdir") as chdir,
        patch.object(os, "execve") as execute,
    ):
        main()
        inspect.assert_called_once_with(["docker", "inspect", worker["web_container"], worker["mysql_container"], worker["minio_container"]], stderr=subprocess.PIPE)
        chdir.assert_called_once_with(Path(worker["checkout"]) / "apps/web")
        mkdir.assert_called_once_with(exist_ok=True, mode=0o700)
        executable, args, environment = execute.call_args.args
        assert executable == worker["bun"] and args[1] == "--conditions=react-server"
        assert environment["DATABASE_URL"] == "mysql://cap:test-password@172.18.0.2:3306/cap"
        assert environment["CAP_INSTANT_FINISH_ORIGIN_URL"] == config["web_url"]
        assert environment["ORIGIN_S3_POLICY"] == worker["s3_policy"]
        assert environment["TMPDIR"] == worker["temp_dir"]
        assert environment["CAP_WORKER_POLL_MS"] == str(worker["poll_ms"])
        assert environment["REVISION_ORIGIN_SERVICE_SECRET"] == "test-secret"
        execute.reset_mock()
        containers[0]["Config"]["Env"][1] = "CAP_REVISION_WORKER_MODE=in-process"
        inspect.return_value = json.dumps(containers).encode()
        try:
            main()
        except ValueError:
            pass
        else:
            raise AssertionError("accepted a competing in-process worker")
        execute.assert_not_called()
    print("worker launcher self-check passed (mocked Docker/exec; no worker started)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"Worker startup failed: {error.__class__.__name__}; check private runtime configuration") from None
