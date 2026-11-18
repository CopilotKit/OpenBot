import { describe, expect, test } from "bun:test";
import { withMathDelimiters } from "@/lib/maths";

/**
 * A Bot's LaTeX delimiters, written in the `$$` Streamdown's maths plugin reads, and nothing else
 * touched. The answers are the shapes models write in a chat: the loan answer below is the one a
 * General Assistant gave on 2026-11-16, which the chat drew as "(P r / [1-(1+r)^{-n}])".
 * maths-rendering.test.tsx draws the same answers in a browser.
 */
describe("maths delimiters", () => {
  test("a formula inside a sentence becomes inline maths, with a price in it kept a dollar", () => {
    expect(
      withMathDelimiters(
        "The monthly payment is **$489.15**, calculated using \\(P r / [1-(1+r)^{-n}]\\), where \\(P=$25,000\\), \\(r=0.065/12\\), and \\(n=60\\).",
      ),
    ).toBe(
      "The monthly payment is **$489.15**, calculated using $$P r / [1-(1+r)^{-n}]$$, where $$P=\\$25{,}000$$, $$r=0.065/12$$, and $$n=60$$.",
    );
  });

  test("a number's thousands separator stays a separator, and a list's comma stays a comma", () => {
    expect(withMathDelimiters("\\(1,000,000 + f(1,2) + x_{1,2,3}\\)")).toBe(
      "$$1{,}000{,}000 + f(1,2) + x_{1,2,3}$$",
    );
  });

  test("a formula on lines of its own becomes a block, at the indent it was written at", () => {
    expect(
      withMathDelimiters(
        "Compound interest:\n\n\\[\nA=P\\left(1+\\frac{r}{n}\\right)^{nt}\n\\]\n\nHere, \\(A\\) is the final balance.",
      ),
    ).toBe(
      "Compound interest:\n\n$$\nA=P\\left(1+\\frac{r}{n}\\right)^{nt}\n$$\n\nHere, $$A$$ is the final balance.",
    );
    expect(
      withMathDelimiters(
        "1. The payment:\n   \\[ M = P\\frac{r}{1-(1+r)^{-n}} \\]",
      ),
    ).toBe("1. The payment:\n   $$\n   M = P\\frac{r}{1-(1+r)^{-n}}\n   $$");
  });

  test("a set-apart formula in the middle of a sentence stays in the line", () => {
    expect(withMathDelimiters("so \\[x^2\\] holds")).toBe("so $$x^2$$ holds");
  });

  test("prices, code and an escaped backslash stay exactly as written", () => {
    const untouched = [
      "The loan is $25,000 at 6.5%, about $489.15 a month, or $5 to $10 more with fees.",
      "Match a call with `\\(\\d+\\)` in the pattern.",
      '```python\nprice = f"$" + amount\npattern = r"\\(\\d+\\)"\n```',
      "~~~\n\\[ not maths \\]\n~~~",
      "A literal \\\\(not an opener\\\\) in prose.",
      "Already maths: $$\\frac{1}{2}$$ and \\(",
      "An opener with no closer \\( in this paragraph.\n\nAnd a closer \\) in the next.",
    ];
    for (const markdown of untouched)
      expect(withMathDelimiters(markdown)).toBe(markdown);
  });

  test("code beside a formula keeps its own text", () => {
    expect(
      withMathDelimiters(
        "Use \\(x_1\\) here.\n\n```js\nconst re = /\\(\\d\\)/;\nconst cost = `$${n}`;\n```\n\nThen \\(x_2\\).",
      ),
    ).toBe(
      "Use $$x_1$$ here.\n\n```js\nconst re = /\\(\\d\\)/;\nconst cost = `$${n}`;\n```\n\nThen $$x_2$$.",
    );
  });

  test("while a reply streams, a formula whose closer has not arrived stays as written", () => {
    expect(withMathDelimiters("Using \\(P r / [1-(1+r)^")).toBe(
      "Using \\(P r / [1-(1+r)^",
    );
    expect(withMathDelimiters("\\[\nA=P\\left(1+")).toBe("\\[\nA=P\\left(1+");
  });
});
