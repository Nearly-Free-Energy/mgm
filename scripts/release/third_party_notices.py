"""Write the third-party notices for an MGM release asset.

    python3 -I third_party_notices.py OUTPUT_DIR NOTICES --project DIR
        --asset NAME --version VERSION --commit SHA [--supplement DIR]

build-deploy-asset.sh calls this after `vercel build`, with the directory the
build ran in; see docs/releasing.md. The notices file is published beside the
asset, never inside it, so the Build Output directory deploys unchanged.

A package is listed when any of these holds:

  - Files of it are in the output. `vercel build --standalone` copies the
    files each function loads at run time into node_modules directories
    inside the function.
  - Its code was bundled into a JavaScript file in the output. The source map
    that the file's sourceMappingURL comment names (beside the file in the
    output, or at the same place in the project directory, where the build
    left it) lists the bundled modules, and a module under node_modules
    belongs to that package. A package that bundles other projects' code, as
    Next.js does in its prebuilt server runtimes, is read the same way from
    its installed source maps.
  - One of the project's stylesheets imports it (`@import "tailwindcss"`).
    The build inlines it into the output's CSS, which has no source map.
  - It is a builder that `vercel build` ran (builds.json). The builder writes
    each function's launcher into the output.
  - It is a vendored directory (see below) that a listed vendored directory
    loads by a path inside the same package. Next.js renders in the browser
    with the React DOM it vendors, which loads the scheduler vendored beside
    it (require("next/dist/compiled/scheduler")).
  - It is bundled into a polyfill file in the output: one that the build
    manifest (.next/build-manifest.json, polyfillFiles) names. Next.js
    serves its prebuilt polyfill bundle to browsers without ES module
    support. The bundle has no source map and the packages in it are not
    installed, so they are listed from the supplement (--supplement, by
    default notices-supplement beside this script). Its supplement.json
    records each reviewed bundle by SHA-256, with the packages bundled into
    it and their licence files, which are kept in the same directory. A
    polyfill file whose SHA-256 it does not record stops the build until
    someone reviews the new bundle and records it.

Client-side JavaScript has no source map in the build. Apart from the last
two cases, its modules are found through the server-side bundles, which
render the same components, so a package imported only by code that never
runs on the server is not found.

A directory inside a package that has its own package.json name and its own
licence file is listed as a package of its own: Next.js ships other projects'
code that way, under dist/compiled.

Each package's name, version and declared licence come from its package.json
in the output, or in the project directory when the output has none. Its
texts are the LICENSE, LICENCE, COPYING and NOTICE files (any case, with or
without a suffix such as .md or -MIT) at the top of the installed package,
because the build copies only the files a function loads and those rarely
include them. A package that ships none is listed with its declared licence
and a note saying so. A package listed from the supplement takes all of
these from the supplement.

The file is deterministic for a given output and project: packages are sorted
by name and version, texts are numbered in the order the sorted packages first
use them, and identical texts (compared after normalising line endings and
trailing whitespace) are printed once.

On success prints the file's SHA-256.
Exit codes: 0 written, 2 usage error, 4 a package, source map, builder,
build manifest or the supplement could not be read, or the supplement does
not record a polyfill file (each problem is printed), 5 writing failed.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import sys
import textwrap
import urllib.parse

EXIT_USAGE = 2
EXIT_CHECK = 4
EXIT_WRITE = 5

LICENCE_FILE = re.compile(r"(licen[cs]e|copying|notice)([._-].*)?", re.IGNORECASE)
NOT_A_LICENCE = re.compile(r".*\.(c?js|mjs|ts|json|map)", re.IGNORECASE)
SCOPE = re.compile(r"@[A-Za-z0-9~][A-Za-z0-9._~-]*")
PACKAGE_NAME = re.compile(r"[A-Za-z0-9~][A-Za-z0-9._~-]*")
SOURCE_MAP_URL = re.compile(r"[#@]\s*sourceMappingURL=(\S+?)\s*(?:\*/)?\s*$")
URL_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:(//)?")
CSS_IMPORT = re.compile(r"""@(?:import|plugin|reference)\s+(?:url\(\s*)?["']([^"']+)["']""")
LOAD = re.compile(r"""(?:\brequire\(\s*|\bfrom\s*|\bimport\(\s*)["']([^"'\n]+)["']""")
SHA256 = re.compile(r"[0-9a-f]{64}")
JAVASCRIPT = (".js", ".mjs", ".cjs")
SUPPLEMENT = Path(__file__).resolve().parent / "notices-supplement"
# Project directories that hold no stylesheet of the project's own.
NOT_SOURCE = {"node_modules", ".next", ".vercel", ".git"}
WIDTH = 72


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="third_party_notices.py", add_help=True)
    parser.add_argument("output_dir")
    parser.add_argument("notices")
    parser.add_argument("--project", required=True)
    parser.add_argument("--asset", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--supplement", default=str(SUPPLEMENT))
    # argparse exits with 2 (EXIT_USAGE) on a usage error and 0 for --help.
    return parser.parse_args(argv)


def split(path):
    return tuple(part for part in path.replace("\\", "/").split("/") if part not in ("", "."))


def package_end(parts, start):
    """Returns the index just past the node_modules/<package> chain at start.

    Follows nested node_modules directories (node_modules/a/node_modules/b)
    and returns start when parts[start:] does not begin with a package.
    """
    end = i = start
    while i + 1 < len(parts) and parts[i] == "node_modules":
        if SCOPE.fullmatch(parts[i + 1]):
            if i + 2 >= len(parts) or not PACKAGE_NAME.fullmatch(parts[i + 2]):
                break
            i += 3
        elif PACKAGE_NAME.fullmatch(parts[i + 1]):
            i += 2
        else:
            break
        end = i
    return end


def read_package_json(directory):
    try:
        with open(directory / "package.json", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def licence_files(directory):
    """The licence and notice files at the top of directory, by name."""
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return {}
    found = {}
    for name in names:
        if LICENCE_FILE.fullmatch(name) and not NOT_A_LICENCE.fullmatch(name) and (directory / name).is_file():
            found[name] = directory / name
    return found


def normalise(raw):
    text = raw.decode("utf-8", errors="replace").lstrip("﻿")
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def declared_licence(data):
    value = data.get("license")
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, dict) and isinstance(value.get("type"), str) and value["type"].strip():
        return value["type"].strip()
    legacy = data.get("licenses")
    if isinstance(legacy, list):
        types = [item.get("type") if isinstance(item, dict) else item for item in legacy]
        types = [t.strip() for t in types if isinstance(t, str) and t.strip()]
        if types:
            return ", ".join(types)
    return None


class Finder:
    """Collects the package directories that files and modules belong to."""

    def __init__(self, project):
        self.project = project
        # Project-relative package directory (a tuple of path parts) -> the
        # directories in the output that hold a copy of it.
        self.components = {}
        # Paths a source map or stylesheet names under node_modules that are
        # not an installed package.
        self.skipped = set()
        self._vendored = {}

    def _is_vendored(self, parts):
        if parts not in self._vendored:
            directory = self.project.joinpath(*parts)
            data = read_package_json(directory)
            self._vendored[parts] = bool(
                data and isinstance(data.get("name"), str) and licence_files(directory)
            )
        return self._vendored[parts]

    def add(self, parts, start, output_root=None):
        """Records the package of the file at parts, relative to the project.

        parts[start] is a node_modules directory. output_root is the output
        directory that stands for the project root, when the file is in the
        output.
        """
        end = package_end(parts, start)
        if end == start or end >= len(parts):
            return
        component = parts[:end]
        for k in range(end + 1, len(parts)):
            if self._is_vendored(parts[:k]):
                component = parts[:k]
                break
        copies = self.components.setdefault(component, set())
        if output_root is not None:
            copies.add(output_root.joinpath(*component))

    def add_installed(self, parts):
        """Records the package of a file the build read from node_modules.

        parts starts at the project's node_modules directory. A path that is
        not in an installed package is skipped and reported: a package's own
        source map can name its original sources by paths that leave it.
        """
        end = package_end(parts, 0)
        if end == 0 or end >= len(parts):
            return
        if not (self.project.joinpath(*parts[:end]) / "package.json").is_file():
            self.skipped.add("/".join(parts[:end]))
            return
        self.add(parts, 0)

    def add_loaded(self, problems):
        """Records the vendored directories that listed ones load.

        A listed vendored directory's installed JavaScript is read for
        require(), import() and `from` specifiers that start with the name of
        the package it is in; the vendored directory such a path leads into
        is listed, and read in turn. Next.js's browser build of the React DOM
        it vendors loads its vendored scheduler this way, and no server-side
        bundle includes that build. Only vendored directories are read, not
        whole packages, whose own files load much that is never shipped.
        """
        queue = sorted(self.components)
        read = set()
        while queue:
            component = queue.pop(0)
            if component in read:
                continue
            read.add(component)
            end = package_end(component, component.index("node_modules"))
            if end >= len(component):
                continue
            owner = (read_package_json(self.project.joinpath(*component[:end])) or {}).get("name")
            if not isinstance(owner, str) or not owner:
                continue
            for path in javascript_files(self.project.joinpath(*component)):
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError as exc:
                    problems.append(f"{path.relative_to(self.project).as_posix()}: unreadable: {exc}")
                    continue
                for specifier in sorted(set(LOAD.findall(text))):
                    if not specifier.startswith(owner + "/"):
                        continue
                    inner = posixpath.normpath(specifier[len(owner) + 1:])
                    if inner.startswith(("../", "/")) or inner in ("..", "."):
                        continue
                    parts = component[:end] + split(inner)
                    for k in range(end + 1, len(parts) + 1):
                        if self._is_vendored(parts[:k]):
                            if parts[:k] not in self.components:
                                self.components[parts[:k]] = set()
                                queue.append(parts[:k])
                            break


def javascript_files(directory):
    """The JavaScript files under directory, outside nested node_modules."""
    for dirpath, dirnames, filenames in os.walk(directory):
        dirnames[:] = sorted(d for d in dirnames if d != "node_modules")
        for name in sorted(filenames):
            if name.endswith(JAVASCRIPT):
                yield Path(dirpath) / name


def function_root(path, output):
    """The .func directory that path is in, or None."""
    for parent in path.parents:
        if parent == output:
            return None
        if parent.name.endswith(".func"):
            return parent
    return None


def locate(path, output):
    """Returns (parts, output root, counterpart) for a file in the output.

    A function directory stands for the project root, so parts is the file's
    path in the project and counterpart (the same) is where the build wrote
    it. static/_next holds what the build wrote to .next. Elsewhere parts is
    the path in the output and there is no counterpart.
    """
    root = function_root(path, output)
    if root is not None:
        parts = path.relative_to(root).parts
        return parts, root, parts
    parts = path.relative_to(output).parts
    if parts[:2] == ("static", "_next"):
        parts = (".next",) + parts[2:]
        return parts, None, parts
    return parts, output, None


def source_map_url(path):
    with open(path, "rb") as fh:
        size = fh.seek(0, os.SEEK_END)
        fh.seek(max(0, size - 4096))
        tail = fh.read().decode("utf-8", errors="replace")
    for line in reversed(tail.splitlines()):
        if line.strip():
            match = SOURCE_MAP_URL.search(line)
            return match.group(1) if match else None
    return None


def load_source_map(url, path, project, counterpart, rel, problems, required):
    """Returns (source map, its directory's parts in the project or None).

    Returns None when there is no readable map. A missing map is a problem
    only when required: packages often keep the comment but leave the map out.
    """
    if url.startswith("data:"):
        header, _, payload = url.partition(",")
        try:
            raw = base64.b64decode(payload) if header.endswith(";base64") else urllib.parse.unquote(payload).encode()
            return json.loads(raw), None
        except ValueError as exc:
            problems.append(f"{rel}: its inline source map is unreadable: {exc}")
            return None
    name = urllib.parse.unquote(url.split("?", 1)[0].split("#", 1)[0])
    candidates = [path.parent / name]
    map_dir = None
    if counterpart is not None:
        in_project = posixpath.normpath("/".join(counterpart[:-1] + (name,)))
        if not in_project.startswith(("../", "/")):
            candidates.append(project / in_project)
            map_dir = split(posixpath.dirname(in_project))
    for candidate in candidates:
        if candidate.is_file():
            try:
                with open(candidate, encoding="utf-8") as fh:
                    return json.load(fh), map_dir
            except (OSError, ValueError) as exc:
                problems.append(f"{rel}: its source map {name} is unreadable: {exc}")
                return None
    if required:
        problems.append(
            f"{rel}: its source map {name} is neither in the output nor in the project directory, "
            "so the packages bundled into it are unknown"
        )
    return None


def map_sources(source_map):
    """Every source a source map lists, including those of an index map."""
    if not isinstance(source_map, dict):
        return
    for source in source_map.get("sources") or []:
        if isinstance(source, str):
            yield source
    for section in source_map.get("sections") or []:
        if isinstance(section, dict):
            yield from map_sources(section.get("map"))


def add_sources(finder, source_map, map_dir, package):
    """Records the packages of the modules a source map lists.

    Bundlers name a module by its path from the project root or from the
    map's directory ("[project]/node_modules/x/...", "../../node_modules/x/
    ..."), so the first node_modules directory in it is the project's. For a
    map inside a package (package is its directory's parts), other sources
    are paths from the map's directory, or webpack://<namespace>/<path from
    the package's root>.
    """
    for source in map_sources(source_map):
        match = URL_SCHEME.match(source)
        scheme = match.group(0).lower() if match else ""
        parts = split(urllib.parse.unquote(source[len(scheme):]))
        if "node_modules" in parts:
            finder.add_installed(parts[parts.index("node_modules"):])
            continue
        if package is None:
            continue
        if scheme == "webpack://":
            base, parts = package, parts[1:]
        elif scheme or map_dir is None:
            continue
        else:
            base = map_dir
        resolved = posixpath.normpath("/".join(base + parts))
        if resolved.startswith(("../", "/")):
            continue
        resolved_parts = split(resolved)
        if resolved_parts[:len(package)] == package:
            finder.add(resolved_parts, resolved_parts.index("node_modules"))


def scan_output(output, finder, problems):
    for dirpath, dirnames, filenames in os.walk(output):
        dirnames.sort()
        directory = Path(dirpath)
        for name in sorted(filenames):
            path = directory / name
            if not stat.S_ISREG(os.lstat(path).st_mode):
                continue
            parts, root, counterpart = locate(path, output)
            package = None
            if "node_modules" in parts:
                start = parts.index("node_modules")
                end = package_end(parts, start)
                if start < end < len(parts):
                    package = parts[:end]
                    finder.add(parts, start, root)
            if not name.endswith(JAVASCRIPT):
                continue
            url = source_map_url(path)
            if url is None:
                continue
            rel = path.relative_to(output).as_posix()
            loaded = load_source_map(url, path, finder.project, counterpart, rel, problems, package is None)
            if loaded is not None:
                add_sources(finder, loaded[0], loaded[1], package)


def scan_stylesheets(project, finder):
    """Records the packages the project's own stylesheets import."""
    for dirpath, dirnames, filenames in os.walk(project):
        dirnames[:] = sorted(d for d in dirnames if d not in NOT_SOURCE)
        for name in sorted(filenames):
            if not name.endswith(".css"):
                continue
            text = (Path(dirpath) / name).read_text(encoding="utf-8", errors="replace")
            for specifier in CSS_IMPORT.findall(text):
                specifier = specifier.lstrip("~")
                if specifier.startswith((".", "/", "#")) or URL_SCHEME.match(specifier):
                    continue
                parts = split(specifier)
                size = 2 if parts and parts[0].startswith("@") else 1
                finder.add_installed(("node_modules",) + parts[:size] + ("package.json",))


def builder_directories(output, problems):
    """The installed package of each builder that builds.json records."""
    try:
        with open(output / "builds.json", encoding="utf-8") as fh:
            builds = json.load(fh)
    except (OSError, ValueError) as exc:
        problems.append(f"builds.json is unreadable: {exc}")
        return []
    found = []
    for build in builds.get("builds") or []:
        use = build.get("use")
        require_path = build.get("requirePath")
        directory = Path(require_path).parent.parent if isinstance(require_path, str) else None
        data = read_package_json(directory) if directory is not None else None
        if not data or data.get("name") != use:
            problems.append(f"builds.json: the package of builder {use!r} is not at its requirePath")
            continue
        found.append(directory)
    return found


def describe(directory, where, copies, origin, problems):
    """Returns the record of the package installed at directory, or None."""
    installed = read_package_json(directory)
    shipped = None
    for copy in sorted(copies):
        shipped = read_package_json(copy)
        if shipped is not None:
            break
    data = shipped or installed
    if data is None:
        problems.append(f"{where}: no package.json in the output or the project directory")
        return None
    if shipped is not None and installed is not None:
        for field in ("name", "version"):
            if shipped.get(field) != installed.get(field):
                problems.append(
                    f"{where}: the output's package.json has {field} {shipped.get(field)!r}, "
                    f"the installed one {installed.get(field)!r}"
                )
                return None
    name = data.get("name") if isinstance(data.get("name"), str) and data.get("name") else where
    version = data.get("version") if isinstance(data.get("version"), str) else None
    files = licence_files(directory)
    for copy in sorted(copies):
        for file_name, path in licence_files(copy).items():
            files.setdefault(file_name, path)
    texts = []
    for file_name in sorted(files):
        try:
            texts.append((file_name, normalise(files[file_name].read_bytes())))
        except OSError as exc:
            problems.append(f"{where}/{file_name}: unreadable: {exc}")
    return {"name": name, "version": version, "origin": origin, "licence": declared_licence(data), "texts": texts}


def owner_of(project, parts, end):
    """Names the installed package at parts[:end] by its name and version."""
    parent = read_package_json(project.joinpath(*parts[:end])) or {}
    owner = " ".join(str(parent[f]) for f in ("name", "version") if parent.get(f))
    return owner or "/".join(parts[:end])


def polyfill_files(output, project, problems):
    """The files in the output that the build manifest names as polyfills."""
    if not (output / "static" / "_next").is_dir():
        return []
    try:
        with open(project / ".next" / "build-manifest.json", encoding="utf-8") as fh:
            manifest = json.load(fh)
    except (OSError, ValueError) as exc:
        problems.append(f".next/build-manifest.json is unreadable, so the polyfill files are unknown: {exc}")
        return []
    names = manifest.get("polyfillFiles", []) if isinstance(manifest, dict) else None
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        problems.append(".next/build-manifest.json: polyfillFiles is not a list of paths")
        return []
    found = []
    for name in sorted(set(names)):
        inner = posixpath.normpath(name)
        path = output.joinpath("static", "_next", *split(inner))
        if inner.startswith(("../", "/")) or inner in ("..", ".") or not path.is_file():
            problems.append(f".next/build-manifest.json: polyfill file {name} is not in the output's static/_next")
            continue
        found.append(path)
    return found


def load_supplement(directory, problems):
    """Returns {SHA-256: (installed file, packages)} from supplement.json.

    Returns None when the supplement cannot be read. Each package's texts are
    read from the files it names, relative to directory.
    """
    index = directory / "supplement.json"
    try:
        with open(index, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        problems.append(f"{index} is unreadable: {exc}")
        return None
    entries = data.get("bundles") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        problems.append(f"{index}: bundles is not a list")
        return None
    bundles = {}
    for number, entry in enumerate(entries, 1):
        where = f"{index}: bundle {number}"
        if not (isinstance(entry, dict) and isinstance(entry.get("sha256"), str)
                and SHA256.fullmatch(entry["sha256"]) and isinstance(entry.get("file"), str)
                and isinstance(entry.get("packages"), list)):
            problems.append(f"{where} needs sha256 (64 lowercase hex digits), file and packages")
            continue
        packages = []
        for package in entry["packages"]:
            if not (isinstance(package, dict)
                    and all(isinstance(package.get(f), str) and package[f] for f in ("name", "version", "license"))
                    and isinstance(package.get("texts"), list) and package["texts"]):
                problems.append(f"{where}: each package needs name, version, license and texts")
                continue
            texts = []
            for name in package["texts"]:
                inner = posixpath.normpath(name) if isinstance(name, str) else ".."
                if inner.startswith(("../", "/")) or inner in ("..", "."):
                    problems.append(f"{where}: {name!r} is not a file in {directory}")
                    continue
                try:
                    raw = directory.joinpath(*split(inner)).read_bytes()
                except OSError as exc:
                    problems.append(f"{where}: {name}: unreadable: {exc}")
                    continue
                texts.append((posixpath.basename(inner), normalise(raw)))
            packages.append({"name": package["name"], "version": package["version"],
                             "licence": package["license"], "texts": sorted(texts)})
        bundles[entry["sha256"]] = (entry["file"], packages)
    return bundles


def add_polyfills(packages, output, project, supplement, problems):
    """Adds the packages bundled into the output's polyfill files."""
    polyfills = polyfill_files(output, project, problems)
    bundles = load_supplement(supplement, problems) if polyfills else None
    if bundles is None:
        return
    for path in polyfills:
        rel = path.relative_to(output).as_posix()
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as exc:
            problems.append(f"{rel}: unreadable: {exc}")
            continue
        if digest not in bundles:
            problems.append(
                f"{rel}: the build manifest names it as a polyfill file, and {supplement / 'supplement.json'} "
                f"records no bundle with its SHA-256 {digest}. Review the packages bundled into it and "
                "record them there (docs/releasing.md)"
            )
            continue
        file, bundled = bundles[digest]
        parts = split(file)
        end = package_end(parts, 0)
        if 0 < end < len(parts):
            origin = f"part of {owner_of(project, parts, end)}, bundled into {'/'.join(parts[end:])}"
        else:
            origin = f"bundled into {file}"
        for package in bundled:
            merge(packages, dict(package, origin=origin))


def collect(output, project, supplement, problems):
    """Returns (packages sorted by name and version, skipped paths)."""
    finder = Finder(project)
    scan_output(output, finder, problems)
    scan_stylesheets(project, finder)
    finder.add_loaded(problems)
    packages = {}
    for component in sorted(finder.components):
        end = package_end(component, component.index("node_modules"))
        origin = None
        if end < len(component):
            origin = f"part of {owner_of(project, component, end)}, at {'/'.join(component[end:])}"
        where = "/".join(component)
        record = describe(project.joinpath(*component), where, finder.components[component], origin, problems)
        if record is not None:
            merge(packages, record)
    for directory in builder_directories(output, problems):
        origin = "builder; writes each function's launcher"
        record = describe(directory, directory.name, set(), origin, problems)
        if record is not None:
            merge(packages, record)
    add_polyfills(packages, output, project, supplement, problems)
    ordered = sorted(
        packages.values(),
        key=lambda p: (p["name"].lower(), p["name"], p["version"] or "", p["origin"] or ""),
    )
    return ordered, sorted(finder.skipped)


def merge(packages, record):
    """Adds record, or its texts to the record of the same package."""
    existing = packages.setdefault((record["name"], record["version"], record["origin"]), record)
    if existing is not record:
        existing["texts"] = sorted(set(existing["texts"]) | set(record["texts"]))


def label(package):
    text = package["name"] + (f" {package['version']}" if package["version"] else "")
    return text + (f" ({package['origin']})" if package["origin"] else "")


def wrap(text, indent="", hanging=""):
    return textwrap.fill(text, WIDTH, initial_indent=indent, subsequent_indent=indent + hanging,
                         break_long_words=False, break_on_hyphens=False)


def render(packages, asset, version, commit):
    numbers = {}
    users = []
    for package in packages:
        for file_name, text in package["texts"]:
            if not text:
                continue
            if text not in numbers:
                numbers[text] = len(numbers) + 1
                users.append([])
            users[numbers[text] - 1].append(f"{label(package)}: {file_name}")

    title = f"Third-party notices for MGM {version}"
    lines = [title, "=" * len(title), ""]
    lines.append(wrap(
        f"{asset}, built from commit {commit}, contains the third-party software listed below. "
        "Each package is listed with its name, version, the licence its package.json declares, "
        "and the licence and notice files it ships. Each distinct text is printed once, in full, "
        "under Texts, and the packages that ship it refer to it by number."
    ))
    lines += ["", f"Packages: {len(packages)}", f"Texts: {len(numbers)}", "", "Packages", "--------", ""]
    for package in packages:
        lines.append(label(package))
        lines.append(f"  Licence: {package['licence'] or 'not declared in package.json'}")
        cited = [f"[{numbers[text]}] {file_name}" for file_name, text in package["texts"] if text]
        empty = [file_name for file_name, text in package["texts"] if not text]
        if cited:
            lines.append(wrap("Texts: " + ", ".join(cited), "  ", "  "))
        if empty:
            lines.append(wrap("Empty files: " + ", ".join(empty), "  ", "  "))
        if not cited:
            lines.append(wrap(
                "Note: no licence or notice text is installed with this package; the licence "
                "above is the one its package.json declares.", "  ", "  "))
        lines.append("")
    lines += ["Texts", "-----", ""]
    for text, number in numbers.items():
        lines.append(wrap(f"[{number}] " + "; ".join(users[number - 1]), "", "    "))
        lines.append("-" * WIDTH)
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def main(argv):
    args = parse_args(argv)
    output = Path(args.output_dir)
    project = Path(args.project)
    notices = Path(args.notices)
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        print("third_party_notices.py: error: --commit must be a full commit SHA", file=sys.stderr)
        return EXIT_USAGE
    if not output.is_dir() or not project.is_dir():
        print("third_party_notices.py: error: the output and project directories must exist", file=sys.stderr)
        return EXIT_USAGE
    output_real = os.path.realpath(output)
    if os.path.realpath(notices).startswith(output_real + os.sep):
        # The notices are published beside the asset; the output deploys as built.
        print("third_party_notices.py: error: the notices file must not be inside the output", file=sys.stderr)
        return EXIT_USAGE

    problems = []
    packages, skipped = collect(output, project, Path(args.supplement), problems)
    for path in skipped:
        print(f"third_party_notices.py: note: skipped {path}: named by a source map or stylesheet, "
              "but not an installed package", file=sys.stderr)
    if problems:
        for problem in sorted(set(problems)):
            print(f"third_party_notices.py: check failed: {problem}", file=sys.stderr)
        return EXIT_CHECK

    content = render(packages, args.asset, args.version, args.commit).encode("utf-8")
    partial = notices.with_name(notices.name + ".partial")
    try:
        partial.write_bytes(content)
        os.replace(partial, notices)
    except OSError as exc:
        print(f"third_party_notices.py: error: writing {notices} failed: {exc}", file=sys.stderr)
        return EXIT_WRITE
    print(hashlib.sha256(content).hexdigest())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
