declare module "gradient-string" {
  type GradientFactory = (input: string) => string;
  type Gradient = ((colors: string[]) => GradientFactory) & Record<string, GradientFactory>;

  const gradient: Gradient;
  export default gradient;
}
