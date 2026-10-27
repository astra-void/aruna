export function ErrorBanner(props: { error?: { name: string } }) {
  return props.error?.name === "ActionValidationError" ? <textlabel Text="Check the form" /> : undefined;
}
