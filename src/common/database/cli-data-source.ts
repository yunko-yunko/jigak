import 'reflect-metadata';
import { createDataSource } from './data-source.js';

// A separate entrypoint keeps CLI discovery from initializing a second Nest connection.
export default createDataSource();
