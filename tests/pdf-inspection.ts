/** Python subprocess configuration shared by the PDF acceptance specs. */
export function pdfInspectionEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, ...(environment.PDF_PYTHONPATH === undefined ? {} : { PYTHONPATH: environment.PDF_PYTHONPATH }) };
}
