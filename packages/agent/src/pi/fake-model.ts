export type FakeModelRequest = {
  readonly prompt: string;
  readonly signal: AbortSignal;
};

export interface FakeModel {
  complete(request: FakeModelRequest): Promise<string>;
}

export const makeFakeModel = (delayMs = 0): FakeModel => ({
  complete: ({ prompt, signal }) =>
    new Promise<string>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new Error("cancelled"));
      if (signal.aborted) {
        onAbort();
        return;
      }

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(`Echo: ${prompt}`);
      }, delayMs);

      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          onAbort();
        },
        { once: true },
      );
    }),
});
