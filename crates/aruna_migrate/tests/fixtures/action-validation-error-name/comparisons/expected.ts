import { invokeAction } from "aruna/client";

export async function buy(itemId: string): Promise<string> {
  try {
    await invokeAction("shop.buy", { itemId });
    return "ok";
  } catch (err) {
    const error = err as { name: string; message: string };
    if (error.name === "ActionValidationError") {
      return "invalid";
    }
    if ("ActionValidationError" == error.name) return "invalid (reversed)";
    if (error?.name !== 'ActionValidationError' && error["name"] != "ActionValidationError") {
      return "other";
    }
    // Wrapped receivers still read `name`.
    if ((err as { name: string }).name === ("ActionValidationError")) return "cast";
    if ((error!).name === "ActionValidationError") return "non-null";
    return "unreachable";
  }
}
