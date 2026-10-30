import { describe, expect, it } from "vitest";
import ptVariants from "../../../examples/plugins/pt-variants/index.ts";

const ctx = (lang: string) => ({ config: {} as never, account: "x", lang });
const run = (text: string, lang: string) => ptVariants.lintText!(text, "caption", ctx(lang)).map((i) => i.message);

describe("pt-variants example plugin", () => {
  it("flags Brazilian words in pt-PT and European words in pt-BR", () => {
    expect(run("Abra no celular.", "pt-PT")).toEqual(['"celular" is Brazilian Portuguese; use "telemóvel" in pt-PT']);
    expect(run("Abra no telemóvel.", "pt-BR")).toEqual(['"telemóvel" is European Portuguese; use "celular" in pt-BR']);
  });

  it("matches whole words, with accents and multi-word entries", () => {
    expect(run("Mostre a carta de   condução.", "pt-PT")).toEqual([]);
    expect(run("Mostre a carta de condução.", "pt-BR")).toHaveLength(1);
    expect(run("Os celulares", "pt-PT")).toEqual([]);
  });

  it("flags 'estar a + infinitive' only in pt-BR", () => {
    expect(run("Estou a fazer o bolo.", "pt-BR")).toHaveLength(1);
    expect(run("Estou fazendo o bolo.", "pt-BR")).toEqual([]);
    expect(run("Estou a fazer o bolo.", "pt-PT")).toEqual([]);
  });

  it("ignores other languages", () => {
    expect(run("Estou a fazer, celular, telemóvel.", "en")).toEqual([]);
    expect(run("celular", "pt")).toEqual([]);
  });
});
