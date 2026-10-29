import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertIcon, Button, CloseIcon, EmptyState, FileIcon } from "agentic-design/react";
import type { ItemKind, SearchHit, SearchPage, SearchRequest } from "../core/types.js";
import { highlighted } from "./highlight.js";

/** The order of the groups. It matches `ITEM_KINDS`, which the UI does not import because it pulls in Node code. */
const KIND_ORDER: readonly ItemKind[] = ["document", "sheet", "slide", "file", "comment"];

export interface SearchBoxLabels {
  /** The accessible name of the search field. */
  field: string;
  placeholder: string;
  loading: string;
  empty: string;
  emptyHint: string;
  error: string;
  retry: string;
  clear: string;
  /** Group headings. */
  kinds: Record<ItemKind, string>;
  /** The live announcement when results arrive. */
  results: (count: number) => string;
}

export const DEFAULT_LABELS: SearchBoxLabels = {
  field: "Search",
  placeholder: "Search documents, sheets, slides, files and comments",
  loading: "Searching",
  empty: "No results",
  emptyHint: "Try other words, or check the spelling.",
  error: "The search failed. Check your connection and try again.",
  retry: "Try again",
  clear: "Clear search",
  kinds: { document: "Documents", sheet: "Sheets", slide: "Slides", file: "Files", comment: "Comments" },
  results: (count) => (count === 1 ? "1 result" : `${count} results`),
};

/** What the box needs from a client. `createClient` from `agentic-search/client` fits. */
export interface SearchSource {
  search(request: SearchRequest, options?: { signal?: AbortSignal }): Promise<SearchPage>;
}

export interface SearchBoxProps {
  client: SearchSource;
  /** Called when a person picks a result, by click or by Enter. */
  onSelect?: (hit: SearchHit) => void;
  /** Wait this long after the last key before the query goes out. Default 200. */
  debounceMs?: number;
  /** Results to ask for. Default 20. */
  limit?: number;
  /** Search only these kinds. */
  kinds?: ItemKind[];
  /** Focus the field on `/` and on Ctrl+K or Cmd+K. Default true. */
  shortcut?: boolean;
  labels?: Partial<SearchBoxLabels>;
}

type State =
  | { status: "idle" }
  | { status: "loading"; hits: SearchHit[] }
  | { status: "ready"; hits: SearchHit[] }
  | { status: "error" };

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** A search field with a results panel. It is a combobox: focus stays in the field, and the arrow keys move through the results. */
export function SearchBox({ client, onSelect, debounceMs = 200, limit = 20, kinds, shortcut = true, labels }: SearchBoxProps) {
  const text = useMemo(() => ({ ...DEFAULT_LABELS, ...labels, kinds: { ...DEFAULT_LABELS.kinds, ...labels?.kinds } }), [labels]);
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const kindsKey = kinds?.join(",") ?? "";
  // Results belong to one client, one kind filter and one page size. When any changes, drop them.
  const scope = useRef({ client, kindsKey, limit });

  // The global shortcut.
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const chord = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTyping(event.target);
      if (!chord && !slash) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  // The debounced query. A newer key, a retry or an unmount cancels the call in flight.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setState({ status: "idle" });
      setActive(-1);
      return;
    }
    const controller = new AbortController();
    const changed = scope.current.client !== client || scope.current.kindsKey !== kindsKey || scope.current.limit !== limit;
    scope.current = { client, kindsKey, limit };
    if (changed) {
      setState({ status: "loading", hits: [] });
      setActive(-1);
    }
    const timer = setTimeout(() => {
      setState((prev) => ({ status: "loading", hits: prev.status === "ready" || prev.status === "loading" ? prev.hits : [] }));
      const request: SearchRequest = { query: trimmed, limit, ...(kindsKey === "" ? {} : { kinds: kindsKey.split(",") as ItemKind[] }) };
      client.search(request, { signal: controller.signal }).then(
        (page) => {
          if (controller.signal.aborted) return;
          setState({ status: "ready", hits: page.hits });
          setActive(-1);
        },
        () => {
          // A failure is shown, never read as an empty result. An abort means a newer call took over.
          if (!controller.signal.aborted) setState({ status: "error" });
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, client, debounceMs, limit, kindsKey, attempt]);

  const hits = state.status === "ready" || state.status === "loading" ? state.hits : [];
  const groups = useMemo(
    () => KIND_ORDER.map((kind) => ({ kind, hits: hits.filter((hit) => hit.kind === kind) })).filter((group) => group.hits.length > 0),
    [hits],
  );
  // The arrow keys walk this list, in the order the groups show.
  const flat = useMemo(() => groups.flatMap((group) => group.hits), [groups]);
  const showPanel = open && state.status !== "idle";
  const showList = showPanel && flat.length > 0 && state.status !== "error";
  const showEmpty = showPanel && state.status === "ready" && flat.length === 0;
  const showSkeleton = showPanel && state.status === "loading" && flat.length === 0;

  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId is derived from id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const choose = useCallback(
    (hit: SearchHit) => {
      onSelect?.(hit);
      setOpen(false);
    },
    [onSelect],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (flat.length === 0) return;
        event.preventDefault();
        setOpen(true);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) => (current < 0 ? (step === 1 ? 0 : flat.length - 1) : (current + step + flat.length) % flat.length));
        break;
      }
      case "Enter": {
        const hit = flat[active];
        if (showList && hit !== undefined) {
          event.preventDefault();
          choose(hit);
        }
        break;
      }
      case "Escape":
        // The first press closes the panel. The second clears the field.
        if (showPanel) setOpen(false);
        else if (query !== "") setQuery("");
        else return;
        event.preventDefault();
        break;
    }
  };

  // The error box is an alert, so the polite region stays quiet then. It does not announce loading.
  const announcement = state.status === "ready" ? (flat.length === 0 ? text.empty : text.results(flat.length)) : "";

  let index = -1;
  return (
    <div
      ref={rootRef}
      className="agd-search"
      role="search"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="agd-search__field">
        <input
          ref={inputRef}
          className="agd-input agd-search__input"
          type="text"
          role="combobox"
          aria-label={text.field}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
          aria-keyshortcuts={shortcut ? "/ Control+K Meta+K" : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={text.placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // The old results stay up while the new query waits, so Enter must not pick one of them.
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query === "" && shortcut ? (
          <kbd className="agd-search__hint" aria-hidden="true">
            /
          </kbd>
        ) : null}
        {query !== "" ? (
          <button
            type="button"
            className="agd-button agd-button--ghost agd-icon-button agd-search__clear"
            aria-label={text.clear}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <CloseIcon aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="agd-sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {showPanel ? (
        <div className="agd-search__panel" aria-busy={state.status === "loading"} tabIndex={showList ? 0 : undefined}>
          {state.status === "error" ? (
            <div className="agd-search__error" role="alert">
              <AlertIcon aria-hidden="true" />
              <p>{text.error}</p>
              <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                {text.retry}
              </Button>
            </div>
          ) : null}
          {showEmpty ? <EmptyState title={text.empty} description={text.emptyHint} /> : null}
          {showSkeleton ? (
            <div className="agd-search__skeleton" aria-hidden="true">
              <span className="agd-skeleton" />
              <span className="agd-skeleton" />
              <span className="agd-skeleton" />
            </div>
          ) : null}
          {showList ? (
            <div role="listbox" id={listId} aria-label={text.field}>
              {groups.map((group) => (
                <div key={group.kind} role="group" aria-labelledby={`${id}-group-${group.kind}`} className="agd-search__group">
                  <div id={`${id}-group-${group.kind}`} className="agd-search__group-title">
                    {text.kinds[group.kind]}
                  </div>
                  {group.hits.map((hit) => {
                    index += 1;
                    const at = index;
                    return (
                      <div
                        key={hit.id}
                        id={optionId(at)}
                        role="option"
                        aria-selected={at === active}
                        className="agd-search__option"
                        data-active={at === active ? "true" : undefined}
                        // Keep focus in the field, so a click does not close the panel.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => active !== at && setActive(at)}
                        onClick={() => choose(hit)}
                      >
                        <FileIcon className="agd-search__icon" aria-hidden="true" />
                        <span className="agd-search__title">{highlighted(hit.title, hit.titleHighlights)}</span>
                        {hit.snippet.text !== "" ? <span className="agd-search__snippet">{highlighted(hit.snippet.text, hit.snippet.highlights)}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
