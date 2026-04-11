import process from "process";
import { Buffer } from "buffer";

(process as any).env ??= {};

(globalThis as any).process ??= process;
(globalThis as any).Buffer ??= Buffer;
(globalThis as any).global ??= globalThis;