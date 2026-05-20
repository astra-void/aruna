export type Result<Ok, Err = never> =
  | {
      readonly ok: true;
      readonly value: Ok;
    }
  | {
      readonly ok: false;
      readonly error: Err;
    };
