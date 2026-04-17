// Ambient typings for the virtual "shapeitup" import source used in .shape.ts
// files. The runtime executor rewrites `import { ... } from "shapeitup"` to
// destructure from an injected object — this file just gives the editor's
// TypeScript service the right types for autocomplete and error checking.
//
// Re-exports everything from the real stdlib module so additions flow here
// automatically.

export * from "../../../core/src/stdlib/index";
