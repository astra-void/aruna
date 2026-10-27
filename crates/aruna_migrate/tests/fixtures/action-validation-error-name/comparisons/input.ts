import { invokeAction } from "aruna/client";

export async function buy(itemId: string): Promise<string> {
  try {
    await invokeAction("shop.buy", { itemId });
    return "ok";
  } catch (err) {
    const error = err as { name: string; message: string };
    if (error.name === "SchemaValidationError") {
      return "invalid";
    }
    if ("SchemaValidationError" == error.name) return "invalid (reversed)";
    if (error?.name !== 'SchemaValidationError' && error["name"] != "SchemaValidationError") {
      return "other";
    }
    // Wrapped receivers still read `name`.
    if ((err as { name: string }).name === ("SchemaValidationError")) return "cast";
    if ((error!).name === "SchemaValidationError") return "non-null";
    return "unreachable";
  }
}
