/**
 * Minimal stand-in for the `vscode` module, aliased in by vitest.config.ts.
 *
 * The extension host cannot be imported under vitest — `vscode` only exists
 * inside a running VS Code — which is why viewer-provider.pending-render.test.ts
 * resorts to copying the methods under test verbatim into a double. That double
 * comes with a standing warning to keep it in sync, i.e. a known drift hazard.
 *
 * This stub removes the need for that pattern going forward: tests exercise the
 * REAL implementation, and only the editor around it is fake.
 *
 * It models just enough to be honest about the behaviour that matters:
 *   - `openTextDocument` returns the buffer, so a test can put unsaved text in
 *     it and check that a commit composes with it rather than clobbering it.
 *   - `applyEdit` actually splices the text, so assertions are on the resulting
 *     document rather than on a recorded call.
 *   - `save()` and `visibleTextEditors` are observable, which is what the
 *     "leave a visible document dirty, save an invisible one" rule turns on.
 *
 * Extend it as more of the extension comes under test; keep it dumb.
 */

export interface StubDoc {
  uri: Uri;
  fileName: string;
  text: string;
  saveCount: number;
  isDirty: boolean;
}

class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

interface RecordedEdit {
  uri: Uri;
  start: number;
  end: number;
  text: string;
}

export class WorkspaceEdit {
  readonly edits: RecordedEdit[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    // `line` carries the raw offset — see TextDocument.positionAt below.
    this.edits.push({ uri, start: range.start.line, end: range.end.line, text });
  }
}

class TextDocument {
  constructor(private readonly doc: StubDoc) {}
  get uri(): Uri {
    return this.doc.uri;
  }
  get fileName(): string {
    return this.doc.fileName;
  }
  get isDirty(): boolean {
    return this.doc.isDirty;
  }
  getText(): string {
    return this.doc.text;
  }
  /**
   * Offsets are smuggled through `Position.line` rather than converted to
   * line/character and back. The code under test only round-trips them through
   * `positionAt` into a Range, so nothing observes the difference — and this
   * way an off-by-one in a conversion we don't own can't masquerade as a bug in
   * the code we're testing.
   */
  positionAt(offset: number): Position {
    return new Position(offset, 0);
  }
  async save(): Promise<boolean> {
    this.doc.saveCount++;
    this.doc.isDirty = false;
    return true;
  }
}

/** Everything a test can set up or inspect. Reset with `__reset()`. */
export const __state = {
  docs: new Map<string, StubDoc>(),
  visiblePaths: new Set<string>(),
  /** Set false to simulate the editor refusing an edit. */
  applyEditSucceeds: true,
  /** Set to make openTextDocument throw. */
  openThrows: null as string | null,
  /** Set to make save() throw. */
  saveThrows: null as string | null,
};

export function __reset(): void {
  __state.docs.clear();
  __state.visiblePaths.clear();
  __state.applyEditSucceeds = true;
  __state.openThrows = null;
  __state.saveThrows = null;
}

export function __addDoc(fsPath: string, text: string, opts: { visible?: boolean } = {}): StubDoc {
  const doc: StubDoc = {
    uri: Uri.file(fsPath),
    fileName: fsPath,
    text,
    saveCount: 0,
    isDirty: false,
  };
  __state.docs.set(fsPath, doc);
  if (opts.visible) __state.visiblePaths.add(fsPath);
  return doc;
}

export const workspace = {
  async openTextDocument(fsPath: string): Promise<TextDocument> {
    if (__state.openThrows) throw new Error(__state.openThrows);
    const doc = __state.docs.get(fsPath);
    if (!doc) throw new Error(`ENOENT: ${fsPath}`);
    const td = new TextDocument(doc);
    if (__state.saveThrows) {
      td.save = async () => {
        throw new Error(__state.saveThrows!);
      };
    }
    return td;
  },
  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    if (!__state.applyEditSucceeds) return false;
    for (const e of edit.edits) {
      const doc = __state.docs.get(e.uri.fsPath);
      if (!doc) return false;
      doc.text = doc.text.slice(0, e.start) + e.text + doc.text.slice(e.end);
      doc.isDirty = true;
    }
    return true;
  },
};

export const window = {
  get visibleTextEditors() {
    return [...__state.visiblePaths]
      .map((p) => __state.docs.get(p))
      .filter((d): d is StubDoc => !!d)
      .map((d) => ({ document: { uri: d.uri } }));
  },
};

export { Uri };
