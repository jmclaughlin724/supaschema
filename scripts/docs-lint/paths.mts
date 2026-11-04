const isDigit = (char: string) => {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
};

const hasMarkdownExtension = (pathname: string) =>
  pathname.endsWith(".md") || pathname.endsWith(".mdx");

export { hasMarkdownExtension, isDigit };
