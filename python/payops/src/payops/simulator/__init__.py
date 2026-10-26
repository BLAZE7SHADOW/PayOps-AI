"""The simulator plays the external world: it writes the gateway tables (it IS the fake gateway) and the internal
records our own systems would have written, with faults injected per scenario. Output is deterministic for a (scenario,
seed) pair, relative to the clock's "now". (packages/simulator)"""
