// The spoke protocol lives in the private workspace package packages/protocol; imported by relative path so the
// published package, the Docker image and compiled binaries need no workspace link.
export * from "../packages/protocol/src/index.ts"
