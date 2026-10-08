import { useSearchParams } from "react-router-dom";

/** Linkable views over a screen (NAV-03): ?view=<name>&id=<record>. Closing returns to the screen. */
export function useView() {
  const [params, setParams] = useSearchParams();
  return {
    view: params.get("view"),
    id: params.get("id"),
    open: (view: string, id?: string) =>
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.set("view", view);
        if (id) n.set("id", id);
        else n.delete("id");
        return n;
      }),
    close: () =>
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.delete("view");
        n.delete("id");
        return n;
      }),
  };
}
