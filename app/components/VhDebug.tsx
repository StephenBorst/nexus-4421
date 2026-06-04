import { useEffect, useState } from "react";

/**
 * TEMP diagnostic overlay — only renders when the URL has ?vhdebug=1.
 * Prints live viewport/layout numbers so we can see, from a real mobile
 * webview, exactly what is creating the bottom "dead space". Safe for prod:
 * invisible unless the flag is present. Remove once the band is fixed.
 */
export default function VhDebug() {
  const on = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("vhdebug") === "1";
  const [, force] = useState(0);

  useEffect(() => {
    if (!on) return;
    const h = () => force((n) => n + 1);
    window.addEventListener("resize", h);
    window.addEventListener("scroll", h, true);
    window.visualViewport?.addEventListener("resize", h);
    window.visualViewport?.addEventListener("scroll", h);
    const id = setInterval(h, 500);
    return () => {
      window.removeEventListener("resize", h);
      window.removeEventListener("scroll", h, true);
      window.visualViewport?.removeEventListener("resize", h);
      window.visualViewport?.removeEventListener("scroll", h);
      clearInterval(id);
    };
  }, [on]);

  if (!on) return null;

  const vv = window.visualViewport;
  const root = document.querySelector(".oui-scaffold-root") as HTMLElement | null;
  const container = document.querySelector(".oui-scaffold-container") as HTMLElement | null;
  const footer = document.querySelector(".oui-scaffold-footer") as HTMLElement | null;
  const r = (el: HTMLElement | null) => (el ? Math.round(el.getBoundingClientRect().bottom) : "—");
  const fHidden = footer ? getComputedStyle(footer).display === "none" : "no-footer";

  const lines = [
    `innerH ${window.innerHeight}  vvH ${vv ? Math.round(vv.height) : "—"}  vvTop ${vv ? Math.round(vv.offsetTop) : "—"}`,
    `screen ${window.screen.height}  docH ${document.documentElement.scrollHeight}`,
    `rootBottom ${r(root)}  contBottom ${r(container)}`,
    `footerHidden ${String(fHidden)}  scrollY ${Math.round(window.scrollY)}`,
  ];

  return (
    <div
      style={{
        position: "fixed", left: 0, right: 0, top: 90, zIndex: 999999,
        background: "rgba(255,0,80,0.92)", color: "#fff",
        fontFamily: "monospace", fontSize: 11, lineHeight: 1.5,
        padding: "8px 10px", pointerEvents: "none", textAlign: "center",
      }}
    >
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}
