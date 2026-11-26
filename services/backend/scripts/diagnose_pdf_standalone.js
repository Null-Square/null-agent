
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const sessionId = 'f4dd5a8b-a49c-4e4d-bf82-a50e5138ea6c';
  // Connection string - try 5433 or check docker ps for port mapping
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15432/nullai_chat';

  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log(`Connected to DB. Listing tables...`);
    
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    console.log('Tables:', tablesRes.rows.map(r => r.table_name).join(', '));

    console.log(`Checking session: ${sessionId}`);
    
    let sessionRes;
    try {
        sessionRes = await client.query('SELECT * FROM agent_sessions WHERE id = $1', [sessionId]);
    } catch (e) {
        console.log('Error querying agent_sessions:', e.message);
        // Fallback or just fail
        return;
    }
    
    const session = sessionRes.rows[0];
    console.log('Session:', session ? 'Found' : 'Not Found');

    if (session) {
      console.log(`Workspace Dir: ${session.workspace_dir}`);
      
      const artifactsRes = await client.query('SELECT * FROM agent_artifacts WHERE session_id = $1', [sessionId]);
      console.log(`Artifacts found: ${artifactsRes.rows.length}`);
      
      for (const a of artifactsRes.rows) {
          console.log(`\n[Artifact] ${a.original_name} (ID: ${a.id})`);
          console.log(`   DB Path: ${a.file_path}`);
          
          const storageRoot = path.resolve(process.cwd(), 'storage', 'artifacts');
          const absPathDefault = path.resolve(storageRoot, a.file_path);
          const existsDefault = fs.existsSync(absPathDefault);
          console.log(`   Exists at default storage (${absPathDefault}): ${existsDefault}`);

          if (session.workspace_dir) {
              const absPathWorkspace = path.resolve(session.workspace_dir, a.file_path);
              const existsWorkspace = fs.existsSync(absPathWorkspace);
              console.log(`   Exists at workspace (${absPathWorkspace}): ${existsWorkspace}`);
          }
      }
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

main();
