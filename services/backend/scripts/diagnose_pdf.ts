
import { db } from '../src/db/client';

async function main() {
  const sessionId = 'f4dd5a8b-a49c-4e4d-bf82-a50e5138ea6c';
  console.log(`Checking session: ${sessionId}`);

  try {
    const session = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    
    console.log('Session:', session ? 'Found' : 'Not Found');

    if (session) {
      const artifacts = await db
        .selectFrom('artifacts')
        .selectAll()
        .where('session_id', '=', sessionId)
        .execute();

      console.log(`Artifacts found: ${artifacts.length}`);
      artifacts.forEach((a) => {
          console.log(` - Name: ${a.original_name}`);
          console.log(`   Path: ${a.file_path}`);
          console.log(`   ID: ${a.id}`);
      });
    }
  } catch (error) {
    console.error('Error querying database:', error);
  } finally {
      await db.destroy();
  }
}

main();
