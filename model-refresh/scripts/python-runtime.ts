/** PYTHON may point at the project's virtual environment on any platform. */
export const PYTHON_COMMAND = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
