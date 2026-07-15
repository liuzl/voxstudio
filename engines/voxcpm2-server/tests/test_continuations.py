from continuations import ContinuationStore


def test_prunes_expired_sessions():
    store = ContinuationStore(ttl_seconds=10)
    store.put("old", {"value": 1}, now=0)
    store.put("live", {"value": 2}, now=5)
    assert store.prune(now=11) == 1
    assert store.get("old") is None
    assert store.get("live") == {"value": 2}


def test_evicts_oldest_when_capacity_is_reached():
    store = ContinuationStore(capacity=2)
    store.put("a", {"value": 1}, now=1)
    store.put("b", {"value": 2}, now=2)
    store.put("c", {"value": 3}, now=3)
    assert store.get("a") is None
    assert store.stats() == {"active": 2, "capacity": 2}


def test_base_anchor_survives_the_session():
    store = ContinuationStore()
    base = {"reference": True}
    merged1 = {"reference": True, "chunk": 1}
    store.put("s", merged1, base)
    assert store.get("s") == merged1
    assert store.get_base("s") is base
    # Later chunks keep re-anchoring to the same base, never to a previous merge.
    merged2 = {"reference": True, "chunk": 2}
    store.put("s", merged2, base)
    assert store.get("s") == merged2
    assert store.get_base("s") is base
    assert store.get_base("missing") is None
