// Answering OpenCode forms (questions) in the web console: initial values, conditional fields, validation, answer.
import { describe, expect, test } from "bun:test"
import { formAnswer, initialFormValues, validateForm, visibleFields, type FormField } from "../web/src/core/form-core"

const question: FormField[] = [
  { key: "q0", type: "string", title: "Color", options: [{ value: "red", label: "red" }, { value: "blue", label: "blue" }], custom: true },
  { key: "q1", type: "multiselect", title: "Sizes", options: [{ value: "S", label: "S" }, { value: "M", label: "M" }] },
]

describe("form-core", () => {
  test("initial values come from defaults; nothing chosen otherwise", () => {
    expect(initialFormValues([...question, { key: "b", type: "boolean", default: true }, { key: "n", type: "integer", default: 3 }])).toEqual({
      q0: "",
      q1: [],
      b: true,
      n: "3",
    })
  })

  test("the question tool's answer: chosen option or custom text, and the multi-select list", () => {
    expect(formAnswer(question, { q0: "blue", q1: ["S", "M"] })).toEqual({ q0: "blue", q1: ["S", "M"] })
    expect(formAnswer(question, { q0: "  my own  ", q1: [] })).toEqual({ q0: "my own", q1: [] })
  })

  test("validation: required, option-only strings, numbers in range, item counts, patterns", () => {
    const fields: FormField[] = [
      { key: "name", type: "string", required: true, minLength: 2, maxLength: 5 },
      { key: "pick", type: "string", options: [{ value: "a", label: "A" }] },
      { key: "age", type: "integer", minimum: 1, maximum: 9 },
      { key: "ratio", type: "number" },
      { key: "tags", type: "multiselect", options: [{ value: "x", label: "x" }, { value: "y", label: "y" }], minItems: 1, maxItems: 1 },
      { key: "code", type: "string", pattern: "^[a-z]+$" },
    ]
    expect(validateForm(fields, { name: "", pick: "zz", age: "1.5", ratio: "abc", tags: [], code: "A1" })).toEqual({
      name: "Required",
      pick: "Choose one of the options",
      age: "Enter a whole number",
      ratio: "Enter a number",
      tags: "Choose at least 1",
      code: "Doesn't match the expected format",
    })
    expect(validateForm(fields, { name: "toolongname", pick: "", age: "12", ratio: "", tags: ["x", "y"], code: "" })).toEqual({
      name: "At most 5 characters",
      age: "At most 9",
      tags: "Choose at most 1",
    })
    expect(validateForm(fields, { name: "ok", pick: "a", age: "3", ratio: "0.5", tags: ["x"], code: "abc" })).toEqual({})
    expect(formAnswer(fields, { name: "ok", pick: "a", age: "3", ratio: "", tags: ["x"], code: "" })).toEqual({ name: "ok", pick: "a", age: 3, tags: ["x"] })
  })

  test("fields with `when` show only while their condition holds, and only shown fields are validated and sent", () => {
    const fields: FormField[] = [
      { key: "mode", type: "string", options: [{ value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }] },
      { key: "value", type: "string", required: true, when: [{ key: "mode", op: "eq", value: "manual" }] },
      { key: "ok", type: "boolean" },
      { key: "link", type: "external", url: "https://example.com" },
    ]
    expect(visibleFields(fields, { mode: "auto" }).map((f) => f.key)).toEqual(["mode", "ok", "link"])
    expect(visibleFields(fields, { mode: "manual" }).map((f) => f.key)).toEqual(["mode", "value", "ok", "link"])
    expect(validateForm(fields, { mode: "auto", value: "", ok: false })).toEqual({})
    expect(validateForm(fields, { mode: "manual", value: "", ok: false })).toEqual({ value: "Required" })
    expect(formAnswer(fields, { mode: "auto", value: "x", ok: false })).toEqual({ mode: "auto", ok: false })
  })
})
