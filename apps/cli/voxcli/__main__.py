"""`vox` -- the voxstudio command line."""

import argparse
import sys

from voxcore import EngineError, load_config

from .commands import chat, health, say, transcribe, voices

COMMANDS = (say, transcribe, chat, voices, health)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="vox", description="voxstudio: self-hosted voice I/O")
    parser.add_argument("--config", help="path to config yaml")
    sub = parser.add_subparsers(dest="command", required=True)
    for module in COMMANDS:
        module.add_parser(sub).set_defaults(_run=module.run)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args._run(args, load_config(args.config))
    except EngineError as exc:
        print(f"engine error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
