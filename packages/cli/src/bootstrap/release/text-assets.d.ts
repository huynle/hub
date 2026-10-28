// Service templates imported `with { type: "text" }` (assets.ts): Bun gives their contents as a string.
declare module "*.plist" {
  const text: string
  export default text
}
declare module "*.service" {
  const text: string
  export default text
}
