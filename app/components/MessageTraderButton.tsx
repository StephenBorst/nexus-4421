// One message affordance, used at EVERY identity surface (feed rows, thesis
// permalink, trader profile, verified callers, smart money) so "message this trader"
// looks and behaves the same everywhere instead of being a one-off per page.
//
// Passing `context` (a call's symbol/direction) turns a cold DM into "discuss THIS
// call" — it seeds the composer with a "Re: your ZEC LONG call —" line via the `re`
// query param, which the Messages thread consumes. Renders nothing unless the viewer
// is connected and looking at someone else (you can't DM yourself).
import { useNavigate } from "react-router-dom";

const bareTicker = (s: string) => s.replace("PERP_", "").replace("_USDC", "");

export function MessageTraderButton({
  wallet,
  myWallet,
  variant = "icon",
  context,
  className,
  style,
  label,
  title,
}: {
  wallet?: string | null;
  myWallet?: string | null;
  variant?: "icon" | "full";
  context?: { symbol?: string; direction?: string };
  className?: string;
  // For surfaces whose button rows use inline styles rather than the .nx-btn class,
  // pass a matching `style` (and no className) so the affordance blends into the row.
  style?: React.CSSProperties;
  label?: string;
  title?: string;
}) {
  const navigate = useNavigate();
  if (!wallet || !myWallet) return null;
  if (wallet.toLowerCase() === myWallet.toLowerCase()) return null;

  const go = () => {
    const p = new URLSearchParams({ dm: wallet });
    if (context?.symbol) {
      const dir = context.direction ? ` ${context.direction}` : "";
      p.set("re", `Re: your ${bareTicker(context.symbol)}${dir} call — `);
    }
    navigate(`/messages?${p.toString()}`);
  };

  return (
    <button
      className={style ? undefined : (className ?? (variant === "full" ? "nx-btn" : "nx-btn nx-btn-icon"))}
      onClick={go}
      title={title ?? (context?.symbol ? "Discuss this call — encrypted DM" : "Send encrypted DM to trader")}
      style={style ? { flexShrink: 0, ...style } : { flexShrink: 0 }}
    >
      {label ?? (variant === "full" ? "⬡ MESSAGE" : "⬡")}
    </button>
  );
}
