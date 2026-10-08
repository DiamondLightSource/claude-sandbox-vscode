// A real IdeLink with the fakes, for the end-to-end tests (kept out of fakes.ts so tests that
// only want fakes do not load the link).

import { IdeLink, type LinkOptions } from "../../src/link.ts";
import { FakeDiagnostics, FakePresenter, MemLogger } from "./fakes.ts";

/** A link on `folder` with fresh fakes; `extra` overrides any option (pass fakes to keep them). */
export function startTestLink(folder: string, extra: Partial<LinkOptions> = {}): Promise<IdeLink> {
  return IdeLink.start({
    folders: [folder],
    presenter: new FakePresenter(),
    diagnostics: new FakeDiagnostics(),
    logger: new MemLogger(),
    ...extra,
  });
}
