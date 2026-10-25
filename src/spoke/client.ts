// The spoke's connection to the central server lives in the spoke SDK (packages/spoke-sdk); re-exported by relative
// path so the published package and compiled binaries need no workspace link.
export * from "../../packages/spoke-sdk/src/connection.ts"
