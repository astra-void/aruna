export function ErrorBanner(props: { error?: { name: string } }) {
  return props.error?.name === "SchemaValidationError" ? <textlabel Text="Check the form" /> : undefined;
}
