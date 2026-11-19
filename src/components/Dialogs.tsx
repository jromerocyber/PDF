// Diálogos propios (sustituyen a window.prompt/confirm, que no funcionan igual en todas las apps de escritorio).
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";

type Req =
  | { kind: "text"; title: string; message: string; password: boolean; resolve: (v: string | null) => void }
  | { kind: "confirm"; title: string; message: string; danger: boolean; resolve: (v: boolean) => void };

let enqueue: ((r: Req) => void) | null = null;

export function askText(title: string, message: string, password = false): Promise<string | null> {
  return new Promise((resolve) => (enqueue ? enqueue({ kind: "text", title, message, password, resolve }) : resolve(window.prompt(message))));
}

export function askConfirm(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => (enqueue ? enqueue({ kind: "confirm", title, message, danger, resolve }) : resolve(window.confirm(message))));
}

export function DialogHost() {
  const [queue, setQueue] = useState<Req[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    return () => {
      enqueue = null;
    };
  }, []);
  const cur = queue[0];
  useEffect(() => input.current?.focus(), [cur]);
  if (!cur) return null;
  const done = (v: string | null | boolean) => {
    if (cur.kind === "text") cur.resolve(v as string | null);
    else cur.resolve(v as boolean);
    setQueue((q) => q.slice(1));
  };
  const cancel = () => done(cur.kind === "text" ? null : false);
  return (
    <Modal title={cur.title} onClose={cancel}>
      <p style={{ whiteSpace: "pre-wrap" }}>{cur.message}</p>
      {cur.kind === "text" ? (
        <form
          className="col"
          onSubmit={(e) => {
            e.preventDefault();
            done(input.current?.value ?? "");
          }}
        >
          <input ref={input} type={cur.password ? "password" : "text"} autoComplete="off" />
          <div className="row end">
            <button type="button" onClick={cancel}>Cancelar</button>
            <button type="submit" className="primary">Aceptar</button>
          </div>
        </form>
      ) : (
        <div className="row end">
          <button onClick={cancel}>Cancelar</button>
          <button className="primary" onClick={() => done(true)} autoFocus>
            {cur.danger ? "Continuar" : "Aceptar"}
          </button>
        </div>
      )}
    </Modal>
  );
}
