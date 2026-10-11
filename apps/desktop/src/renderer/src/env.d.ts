import type { HiveApi } from "../../shared/api.ts";

declare global {
  interface Window {
    hive: HiveApi;
  }
}
