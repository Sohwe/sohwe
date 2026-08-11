import { useEffect, useState } from "react";

function eventSourceBase(): string {
  return import.meta.env.DEV || !import.meta.env.VITE_API_URL
    ? ""
    : (import.meta.env.VITE_API_URL as string);
}

export type LogStream = {
  text: string;
  /** False while the browser is retrying a dropped connection. */
  connected: boolean;
};

/**
 * Subscribe to one of the API's log SSE endpoints.
 *
 * Both endpoints speak the same protocol: a single `replay` frame carrying
 * everything stored so far, then a `line` frame per new line. `EventSource`
 * reconnects on its own and the server replays from the top each time, so a
 * replay *replaces* the buffer — appending it would duplicate the prefix on
 * every reconnect.
 */
export function useLogStream(path: string): LogStream {
  const [text, setText] = useState("");
  const [connected, setConnected] = useState(false);

  // Switching endpoints starts a different stream, so the buffer from the old
  // one must not linger. Adjusting during render (rather than in an effect)
  // avoids rendering one frame of the previous app's logs under the new id.
  const [streamPath, setStreamPath] = useState(path);
  if (streamPath !== path) {
    setStreamPath(path);
    setText("");
    setConnected(false);
  }

  useEffect(() => {
    const es = new EventSource(`${eventSourceBase()}${path}`);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const j = JSON.parse(ev.data) as
          | { type: "replay"; text: string }
          | { type: "line"; line: string };
        if (j.type === "replay") setText(j.text);
        if (j.type === "line") setText((t) => t + `${j.line}\n`);
      } catch {
        /* ignore malformed frames */
      }
    };

    return () => {
      es.close();
    };
  }, [path]);

  return { text, connected };
}
