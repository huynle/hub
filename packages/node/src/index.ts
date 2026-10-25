// `hub node` (design §6.3): the per-machine daemon. It connects out to the hub's /spoke/ws with the machine's
// token and a node hello, and serves prepare → collect → cleanup (and cancel) for each launch through its runtimes.
export {}
