import { INestApplication, ValidationPipe } from '@nestjs/common';

// Shared by main.ts and the tests, so tests run the app exactly as it runs in Docker.
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Lets Nest run shutdown hooks on SIGTERM (docker stop / deploys).
  app.enableShutdownHooks();
  return app;
}
