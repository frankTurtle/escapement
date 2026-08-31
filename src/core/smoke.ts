export type Ping = { readonly kind: "ping" };
export const ping = (): Ping => ({ kind: "ping" });
