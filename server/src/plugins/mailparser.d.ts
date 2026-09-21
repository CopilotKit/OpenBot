/**
 * mailparser ships no types and has no @types package.
 *
 * Declared narrowly rather than as `any`: this module uses exactly one export, and the two fields of
 * its result that matter. A wider shim would assert knowledge of an API nothing here calls.
 */
declare module "mailparser" {
  export type ParsedMail = {
    text?: string;
    html?: string | false;
    subject?: string;
  };
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}
