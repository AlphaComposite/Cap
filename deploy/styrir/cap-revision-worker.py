import json
import os
from pathlib import Path
import subprocess
import sys

release = Path("/srv/styrir/releases/cap/d0708cd9c0")
origin_file = Path("/srv/styrir/shared/env/cap-origin.env")
origin = dict(line.split("=", 1) for line in origin_file.read_text().splitlines() if line and "=" in line)
containers = json.loads(subprocess.check_output(["docker", "inspect", "cap-web", "cap-mysql", "cap-minio"]))
items = {item["Name"].removeprefix("/"): item for item in containers}
env = dict(os.environ)
env.update(dict(value.split("=", 1) for value in items["cap-web"]["Config"]["Env"] if "=" in value))
env.update(origin)
mysql_ip = items["cap-mysql"]["NetworkSettings"]["Networks"]["cap_cap-network"]["IPAddress"]
env["DATABASE_URL"] = env["DATABASE_URL"].replace("@mysql:", "@" + mysql_ip + ":")
minio_env = dict(value.split("=", 1) for value in items["cap-minio"]["Config"]["Env"] if "=" in value)
for key in ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]:
    env[key] = minio_env[key]
env["S3_INTERNAL_ENDPOINT"] = "http://127.0.0.1:9010"
env["CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL"] = "http://127.0.0.1:3020"
env["CAP_INSTANT_FINISH_ORIGIN_URL"] = "https://cap.styrir.com"
env["CAP_REVISION_WORKER_MODE"] = "external"
env["CAP_INSTANT_FINISH_OWNERS"] = items["cap-web"]["Config"]["Env"] and dict(value.split("=", 1) for value in items["cap-web"]["Config"]["Env"] if "=" in value).get("CAP_INSTANT_FINISH_OWNERS", "")
env["ORIGIN_S3_POLICY"] = "cap-production-origin-exact-keys"
env["TMPDIR"] = "/srv/styrir/backups/cap/production-release-reader57/worker-tmp"
Path(env["TMPDIR"]).mkdir(exist_ok=True, mode=0o700)
env["PATH"] = "/root/.local/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
program = '''
const {db}=await import("@cap/database");
const {httpOriginClient}=await import("./lib/revision-publication-origin.ts");
const {startRevisionReadbackWorker}=await import("./lib/revision-publication.ts");
const {reconcileOriginReadPolicy}=await import("./lib/instant-finish-source-relocate.ts");
const database=db();
const worker=startRevisionReadbackWorker({database,origin:httpOriginClient(),pollMs:1500,onTick:async()=>{await reconcileOriginReadPolicy(database);}});
console.log("CAP_EXTERNAL_REVISION_WORKER_STARTED");
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>{worker.stop();process.exit(0);});
'''
os.chdir(release / "src/apps/web")
os.execve("/root/.bun/bin/bun", ["bun", "--conditions=react-server", "-e", program], env)
