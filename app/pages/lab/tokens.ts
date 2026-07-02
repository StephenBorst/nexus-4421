// The Nexus design tokens now live app-wide in app/config/theme.ts (promoted so
// Feed/Messages/mini/components share ONE system, not just the Lab). This re-export
// keeps existing `./tokens` imports working — prefer importing from "@/config/theme"
// in new code.
export * from "@/config/theme";
