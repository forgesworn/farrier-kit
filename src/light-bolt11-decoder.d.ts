// Test-only dev dependency used for cross-validation; it ships no types.
declare module 'light-bolt11-decoder' {
  export function decode(paymentRequest: string): {
    sections: Array<{ name?: string; value?: unknown }>
  }
}
