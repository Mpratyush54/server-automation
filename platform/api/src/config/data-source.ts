/**
 * DataSource entry point for the TypeORM CLI (`npm run migration:*`). The CLI
 * requires a module that exports exactly one DataSource.
 */
import { AppDataSource } from './database';

export default AppDataSource;
