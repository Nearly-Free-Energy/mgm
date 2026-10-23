"""Check a Vercel Build Output directory and pack it as an MGM release asset.

    python3 -I vercel_build_output.py OUTPUT_DIR ARCHIVE --info FILE
        --version VERSION --commit SHA --mtime EPOCH --target TARGET
        --node-runtime RUNTIME --vercel-cli VERSION [--require-linux-x64]

build-deploy-asset.sh calls this after `vercel build`; see docs/releasing.md.

The checks refuse an output that could not be deployed as it stands from a
fresh directory, or that targets the wrong place:

  - builds.json records the expected build target. `vercel deploy --prebuilt`
    accepts a production-target output only with --prod, and a preview-target
    one only without it.
  - No function config has a filePathMap. Without `vercel build --standalone`
    each function lists files to copy from the project's node_modules and
    .next, which do not exist where the asset is deployed.
  - Every Node.js function declares the runtime pinned by .nvmrc.
  - With --require-linux-x64, every Node.js function declares x86_64 (or no
    architecture, which Vercel reads as x86_64), and every native binary is
    ELF x86-64. The build copies only the build host's native modules and
    records the host's architecture, so only a Linux x86-64 build runs on
    Vercel's Node.js runtime.
  - Every symlink is relative and resolves to an existing entry inside the
    output, so extracting the archive cannot write outside its directory.
  - No .env file other than a committed *.example template is present.
  - Only directories, regular files and symlinks.

The archive is deterministic for a given output: entries are relative to the
output root and sorted, with uid/gid 0, empty owner names, the given mtime,
modes 0755 or 0644, symlinks kept as symlinks and hard links stored as regular
files; the gzip header has no file name and no timestamp. The build itself is
not reproducible (each Next.js build gets its own build ID), so the asset is
identified by its SHA-256 and its attestation, not by rebuilding it.

On success prints the archive's SHA-256 and writes the --info JSON.
Exit codes: 0 packed, 2 usage error, 4 the output failed a check (each
problem is printed), 5 packing failed.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import tarfile

EXIT_USAGE = 2
EXIT_CHECK = 4
EXIT_PACK = 5

ELF_MAGIC = b"\x7fELF"
ELFCLASS64 = 2
ELFDATA2LSB = 1
EM_X86_64 = 62
MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",  # 32-bit, either byte order
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",  # 64-bit, either byte order
}
ELF_MACHINES = {3: "x86", 40: "ARM", 62: "x86-64", 183: "aarch64"}


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="vercel_build_output.py", add_help=True)
    parser.add_argument("output_dir")
    parser.add_argument("archive")
    parser.add_argument("--info", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--mtime", required=True, type=int)
    parser.add_argument("--target", required=True, choices=["production", "preview"])
    parser.add_argument("--node-runtime", required=True)
    parser.add_argument("--vercel-cli", required=True)
    parser.add_argument("--require-linux-x64", action="store_true")
    # argparse exits with 2 (EXIT_USAGE) on a usage error and 0 for --help.
    return parser.parse_args(argv)


def read_json(path, problems, label):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        problems.append(f"{label} is missing")
    except (OSError, ValueError) as exc:
        problems.append(f"{label} is unreadable: {exc}")
    return None


def binary_format(path):
    """Describes a native binary, or returns None for any other file."""
    with open(path, "rb") as fh:
        head = fh.read(20)
    if head[:4] == ELF_MAGIC and len(head) >= 20:
        bits = "64-bit" if head[4] == ELFCLASS64 else "32-bit"
        order = "little" if head[5] == ELFDATA2LSB else "big"
        machine = int.from_bytes(head[18:20], order)
        name = ELF_MACHINES.get(machine, f"machine {machine}")
        return {"kind": "elf", "x86_64": head[4] == ELFCLASS64 and machine == EM_X86_64,
                "text": f"ELF {bits} {name}"}
    if head[:4] in MACHO_MAGICS:
        return {"kind": "mach-o", "x86_64": False, "text": "Mach-O"}
    if path.name.endswith(".node"):
        return {"kind": "unknown", "x86_64": False, "text": "not an ELF or Mach-O binary"}
    return None


def builder_version(build):
    """Reads the version of the framework builder `vercel build` loaded."""
    require_path = build.get("requirePath")
    if not isinstance(require_path, str):
        return None
    package = Path(require_path).parent.parent / "package.json"
    try:
        with open(package, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if data.get("name") != build.get("use"):
        return None
    version = data.get("version")
    return version if isinstance(version, str) else None


def check_output(root, target, node_runtime, vercel_cli, require_linux_x64):
    """Returns (problems, facts) for the Build Output directory at root."""
    problems = []
    facts = {
        "functions": {"nodejs": 0, "edge": 0, "other": 0, "aliases": 0},
        "runtimes": set(),
        "architectures": set(),
        "frameworks": set(),
        "nativeBinaries": [],
        "entries": 0,
    }
    if not root.is_dir():
        return [f"{root} is not a directory"], facts

    config = read_json(root / "config.json", problems, "config.json")
    if config is not None and config.get("version") != 3:
        problems.append("config.json is not Build Output API version 3")

    builds = read_json(root / "builds.json", problems, "builds.json")
    facts["builders"] = []
    if builds is not None:
        if builds.get("target") != target:
            problems.append(
                f"builds.json records target {builds.get('target')!r}, expected {target!r}: "
                "vercel deploy --prebuilt refuses a target it was not asked for"
            )
        if builds.get("cliVersion") != vercel_cli:
            problems.append(f"builds.json records Vercel CLI {builds.get('cliVersion')!r}, expected {vercel_cli!r}")
        for build in builds.get("builds") or []:
            facts["builders"].append({"use": build.get("use"), "version": builder_version(build)})

    root_real = os.path.realpath(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(dirnames + filenames):
            full = Path(dirpath) / name
            rel = full.relative_to(root).as_posix()
            facts["entries"] += 1
            mode = os.lstat(full).st_mode
            if name.startswith(".env") and not name.endswith(".example"):
                problems.append(f"{rel}: an environment file must not be part of the asset")
            if stat.S_ISLNK(mode):
                check_symlink(full, rel, root_real, problems)
                if name.endswith(".func"):
                    facts["functions"]["aliases"] += 1
            elif stat.S_ISREG(mode):
                if name == ".vc-config.json" and "node_modules" not in Path(rel).parts:
                    check_function(full, rel, node_runtime, require_linux_x64, problems, facts)
                if rel.startswith("functions/"):
                    described = binary_format(full)
                    if described is not None:
                        facts["nativeBinaries"].append({"path": rel, "format": described["text"]})
                        if require_linux_x64 and not described["x86_64"]:
                            problems.append(
                                f"{rel}: {described['text']}; Vercel's Node.js runtime needs Linux x86-64 "
                                "(build on a Linux x86-64 host)"
                            )
            elif not stat.S_ISDIR(mode):
                problems.append(f"{rel}: not a directory, regular file or symlink")

    counted = facts["functions"]["nodejs"] + facts["functions"]["edge"] + facts["functions"]["other"]
    if counted == 0:
        problems.append("the output has no functions")
    return problems, facts


def check_symlink(full, rel, root_real, problems):
    target = os.readlink(full)
    if os.path.isabs(target):
        problems.append(f"{rel}: symlink to an absolute path")
        return
    resolved = os.path.realpath(full)
    if not (resolved == root_real or resolved.startswith(root_real + os.sep)):
        problems.append(f"{rel}: symlink resolves outside the output")
    elif not os.path.exists(resolved):
        problems.append(f"{rel}: symlink to a missing entry")


def check_function(full, rel, node_runtime, require_linux_x64, problems, facts):
    config = read_json(full, problems, rel)
    if config is None:
        return
    if "filePathMap" in config:
        problems.append(
            f"{rel}: has a filePathMap, so the function reads files from outside the output "
            "(build with vercel build --standalone)"
        )
    runtime = config.get("runtime")
    framework = config.get("framework")
    if isinstance(framework, dict) and framework.get("slug"):
        facts["frameworks"].add(f"{framework.get('slug')} {framework.get('version')}")
    if isinstance(runtime, str) and runtime.startswith("nodejs"):
        facts["functions"]["nodejs"] += 1
        facts["runtimes"].add(runtime)
        architecture = config.get("architecture")
        facts["architectures"].add(architecture or "x86_64")
        if runtime != node_runtime:
            problems.append(f"{rel}: runtime {runtime}, expected {node_runtime} (from .nvmrc)")
        if require_linux_x64 and architecture not in (None, "x86_64"):
            problems.append(
                f"{rel}: architecture {architecture}; Vercel's Node.js runtime needs x86_64 "
                "(build on a Linux x86-64 host)"
            )
    elif runtime == "edge":
        facts["functions"]["edge"] += 1
        facts["runtimes"].add(runtime)
    else:
        facts["functions"]["other"] += 1
        facts["runtimes"].add(str(runtime))


def pack(root, archive, mtime):
    """Writes the archive and returns (number of entries, sha256, bytes)."""
    paths = []
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            paths.append(os.path.relpath(os.path.join(dirpath, name), root))
    paths.sort()

    partial = archive.with_name(archive.name + ".partial")
    with open(partial, "wb") as raw, gzip.GzipFile(
        filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0
    ) as gz, tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for rel in paths:
            full = os.path.join(root, rel)
            st = os.lstat(full)
            info = tarfile.TarInfo(rel)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = mtime
            if stat.S_ISLNK(st.st_mode):
                info.type = tarfile.SYMTYPE
                info.linkname = os.readlink(full)
                info.mode = 0o777
                tar.addfile(info)
            elif stat.S_ISDIR(st.st_mode):
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            else:
                info.type = tarfile.REGTYPE
                info.mode = 0o755 if st.st_mode & 0o111 else 0o644
                info.size = st.st_size
                with open(full, "rb") as fh:
                    tar.addfile(info, fh)
    os.replace(partial, archive)

    digest = hashlib.sha256()
    with open(archive, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return len(paths), digest.hexdigest(), archive.stat().st_size


def main(argv):
    args = parse_args(argv)
    root = Path(args.output_dir)
    archive = Path(args.archive)
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        print("vercel_build_output.py: error: --commit must be a full commit SHA", file=sys.stderr)
        return EXIT_USAGE

    problems, facts = check_output(
        root, args.target, args.node_runtime, args.vercel_cli, args.require_linux_x64
    )
    if problems:
        for problem in problems:
            print(f"vercel_build_output.py: check failed: {problem}", file=sys.stderr)
        return EXIT_CHECK

    try:
        entries, sha256, size = pack(root, archive, args.mtime)
    except OSError as exc:
        print(f"vercel_build_output.py: error: packing failed: {exc}", file=sys.stderr)
        return EXIT_PACK

    info = {
        "asset": archive.name,
        "version": args.version,
        "commit": args.commit,
        "target": args.target,
        "sha256": sha256,
        "bytes": size,
        "entries": entries,
        "builtOn": f"{platform.system().lower()}-{platform.machine()}",
        "vercelCli": args.vercel_cli,
        "builders": facts["builders"],
        "frameworks": sorted(facts["frameworks"]),
        "functions": facts["functions"],
        "runtimes": sorted(facts["runtimes"]),
        "architectures": sorted(facts["architectures"]),
        "nativeBinaries": facts["nativeBinaries"],
    }
    try:
        with open(args.info, "w", encoding="utf-8") as fh:
            json.dump(info, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        print(f"vercel_build_output.py: error: writing {args.info} failed: {exc}", file=sys.stderr)
        return EXIT_PACK
    print(sha256)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
