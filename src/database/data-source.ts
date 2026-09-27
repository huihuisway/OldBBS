import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from '../config';
import * as entities from './entities';

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: config.database.host,
  port: config.database.port,
  username: config.database.user,
  password: config.database.password,
  database: config.database.name,
  socketPath: config.database.socketPath,
  charset: 'utf8mb4',
  entities: Object.values(entities),
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  migrationsRun: false,
  logging: config.nodeEnv === 'development' ? ['error', 'warn'] : ['error'],
  extra: { connectionLimit: 10, enableKeepAlive: true },
});

export default AppDataSource;
