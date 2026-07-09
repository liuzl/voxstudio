"""`vox health` -- probe every configured engine."""

from voxcore import probe


def add_parser(sub):
    return sub.add_parser("health", help="probe configured engines")


def run(args, cfg) -> int:
    results = [probe(name, engine) for name, engine in sorted(cfg.engines.items())]
    width = max(len(r.base_url) for r in results)
    for r in results:
        mark = "ok  " if r.ok else "FAIL"
        print(f"{mark}  {r.name:<4} {r.base_url:<{width}}  {r.model:<14} {r.detail}")
    return 0 if all(r.ok for r in results) else 1
