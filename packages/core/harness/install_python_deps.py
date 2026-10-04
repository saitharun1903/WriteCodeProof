"""Install a Python project's dependencies into a target folder.

Usage: python install_python_deps.py <project_dir> <target_dir>

Reads requirements*.txt files and the [project] table of pyproject.toml
(dependencies plus the usual test/dev extras). The project itself is not
installed; it is put on PYTHONPATH instead.
"""

import subprocess
import sys
import tomllib
from pathlib import Path

REQUIREMENT_FILES = [
    "requirements.txt",
    "requirements-dev.txt",
    "requirements-test.txt",
    "dev-requirements.txt",
    "test-requirements.txt",
]
TEST_EXTRAS = ["test", "tests", "testing", "dev"]


def pyproject_requirements(project: Path) -> list[str]:
    path = project / "pyproject.toml"
    if not path.is_file():
        return []
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    table = data.get("project", {})
    reqs = list(table.get("dependencies", []))
    extras = table.get("optional-dependencies", {})
    for name in TEST_EXTRAS:
        reqs.extend(extras.get(name, []))
    groups = data.get("dependency-groups", {})
    for name in TEST_EXTRAS:
        reqs.extend(r for r in groups.get(name, []) if isinstance(r, str))
    return reqs


def main() -> int:
    project, target = Path(sys.argv[1]), Path(sys.argv[2])
    args: list[str] = []
    for name in REQUIREMENT_FILES:
        if (project / name).is_file():
            args += ["-r", str(project / name)]
    args += pyproject_requirements(project)
    target.mkdir(parents=True, exist_ok=True)
    if not args:
        print("no dependencies")
        return 0
    cmd = [sys.executable, "-m", "pip", "install", "--no-input", "--target", str(target), *args]
    return subprocess.call(cmd, cwd=project)


if __name__ == "__main__":
    sys.exit(main())
