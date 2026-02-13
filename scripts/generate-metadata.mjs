#!/usr/bin/env node

import { program } from 'commander';
import { MetadataGenerator } from '../node/lib/metadataGenerator.mjs';
import { createCategoryLogger } from '../node/lib/logger.mjs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const logger = createCategoryLogger('metadata-cli');

/**
 * CLI wrapper for the metadata generator
 * Provides command-line interface matching Python script functionality
 */

program
  .name('generate-metadata')
  .description('Generate TMDB metadata for TV shows and movies')
  .version('1.0.0');

program
  .command('show <name>')
  .description('Generate metadata for a specific TV show')
  .option('-f, --force', 'Force refresh even if metadata is up to date')
  .option('--no-blurhash', 'Skip blurhash generation for images')
  .option('--base-path <path>', 'Base path for media directories', process.env.BASE_PATH || '/var/www/html')
  .action(async (name, options) => {
    try {
      logger.info(`Generating metadata for TV show: ${name}`);
      
      const generator = await MetadataGenerator.create({
        basePath: options.basePath,
        forceRefresh: options.force,
        generateBlurhash: options.blurhash
      });

      const result = await generator.generateForShow(name);
      
      if (result.success) {
        if (result.updated) {
          console.log(`✅ Successfully generated metadata for "${name}"`);
          console.log(`   TMDB ID: ${result.tmdbId}`);
          console.log(`   Transaction ID: ${result.transactionId}`);
          
          if (result.seasonResults) {
            console.log(`   Seasons processed: ${result.seasonResults.length}`);
          }
          
          if (result.imageResults) {
            const downloadedImages = Object.values(result.imageResults).filter(r => r.success);
            console.log(`   Images downloaded: ${downloadedImages.length}`);
          }
        } else {
          console.log(`ℹ️  No update needed for "${name}" - ${result.reason}`);
        }
      } else {
        console.error(`❌ Failed to generate metadata for "${name}": ${result.error}`);
        process.exit(1);
      }
      
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      logger.error('CLI show command failed', { name, error: error.message });
      process.exit(1);
    }
  });

program
  .command('movie <name>')
  .description('Generate metadata for a specific movie')
  .option('-f, --force', 'Force refresh even if metadata is up to date')
  .option('--no-blurhash', 'Skip blurhash generation for images')
  .option('--base-path <path>', 'Base path for media directories', process.env.BASE_PATH || '/var/www/html')
  .action(async (name, options) => {
    try {
      logger.info(`Generating metadata for movie: ${name}`);
      
      const generator = await MetadataGenerator.create({
        basePath: options.basePath,
        forceRefresh: options.force,
        generateBlurhash: options.blurhash
      });

      const result = await generator.generateForMovie(name);
      
      if (result.success) {
        if (result.updated) {
          console.log(`✅ Successfully generated metadata for "${name}"`);
          console.log(`   TMDB ID: ${result.tmdbId}`);
          console.log(`   Transaction ID: ${result.transactionId}`);
          
          if (result.imageResults) {
            const downloadedImages = Object.values(result.imageResults).filter(r => r.success);
            console.log(`   Images downloaded: ${downloadedImages.length}`);
          }
        } else {
          console.log(`ℹ️  No update needed for "${name}" - ${result.reason}`);
        }
      } else {
        console.error(`❌ Failed to generate metadata for "${name}": ${result.error}`);
        process.exit(1);
      }
      
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      logger.error('CLI movie command failed', { name, error: error.message });
      process.exit(1);
    }
  });

program
  .command('all <type>')
  .description('Generate metadata for all shows or movies')
  .argument('<type>', 'Media type: "tv" or "movies"')
  .option('-f, --force', 'Force refresh even if metadata is up to date')
  .option('--no-blurhash', 'Skip blurhash generation for images')
  .option('--base-path <path>', 'Base path for media directories', process.env.BASE_PATH || '/var/www/html')
  .option('--max-concurrent <number>', 'Maximum concurrent processes', '3')
  .action(async (type, options) => {
    try {
      if (!['tv', 'movies'].includes(type)) {
        console.error('❌ Type must be "tv" or "movies"');
        process.exit(1);
      }

      logger.info(`Processing all ${type}`);
      console.log(`🚀 Starting bulk processing of ${type}...`);
      
      const generator = await MetadataGenerator.create({
        basePath: options.basePath,
        forceRefresh: options.force,
        generateBlurhash: options.blurhash,
        maxConcurrent: parseInt(options.maxConcurrent)
      });

      const result = await generator.processDirectory(type);
      
      if (result.success) {
        console.log(`\n✅ Bulk processing completed!`);
        console.log(`   Total processed: ${result.processed}`);
        console.log(`   Successful: ${result.successCount}`);
        console.log(`   Errors: ${result.errorCount}`);
        console.log(`   Transaction ID: ${result.transactionId}`);
        
        // Show summary of errors if any
        if (result.errorCount > 0) {
          console.log(`\n⚠️  Failed items:`);
          const failed = result.results.filter(r => !r.success);
          failed.slice(0, 10).forEach(item => { // Show first 10 failures
            console.log(`   - ${item.name}: ${item.error}`);
          });
          
          if (failed.length > 10) {
            console.log(`   ... and ${failed.length - 10} more`);
          }
        }
      } else {
        console.error(`❌ Bulk processing failed: ${result.error}`);
        process.exit(1);
      }
      
    } catch (error) {
      console.error(`❌ Error: ${error.message}`);
      logger.error('CLI all command failed', { type, error: error.message });
      process.exit(1);
    }
  });

program
  .command('test')
  .description('Test configuration and TMDB connectivity')
  .action(async () => {
    try {
      console.log('🔧 Testing metadata generator configuration...\n');
      
      // Test environment variables
      const basePath = process.env.BASE_PATH;
      const tmdbApiKey = process.env.TMDB_API_KEY;
      
      console.log('Environment Variables:');
      console.log(`   BASE_PATH: ${basePath || '❌ Not set'}`);
      console.log(`   TMDB_API_KEY: ${tmdbApiKey ? '✅ Set' : '❌ Not set'}`);
      
      if (!tmdbApiKey) {
        console.log('\n❌ TMDB_API_KEY is required. Please set it in your environment or .env file.');
        process.exit(1);
      }
      
      // Test TMDB connectivity
      console.log('\n🌐 Testing TMDB API connectivity...');
      
      const { searchMedia } = await import('../node/utils/tmdb.mjs');
      const testResult = await searchMedia('tv', 'Breaking Bad');
      
      if (testResult.results && testResult.results.length > 0) {
        console.log('✅ TMDB API connection successful');
        console.log(`   Found ${testResult.results.length} results for "Breaking Bad"`);
      } else {
        console.log('⚠️  TMDB API connected but no results found');
      }
      
      // Test metadata generator initialization
      console.log('\n🏗️  Testing metadata generator initialization...');
      
      const generator = await MetadataGenerator.create({
        basePath: basePath || '/tmp/test',
        forceRefresh: false,
        generateBlurhash: false
      });
      
      console.log('✅ Metadata generator initialized successfully');
      
      console.log('\n🎉 All tests passed! Ready to generate metadata.');
      
    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
      logger.error('CLI test command failed', { error: error.message });
      process.exit(1);
    }
  });

// Add global error handling
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', { reason });
  console.error('❌ Unexpected error occurred');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message });
  console.error('❌ Unexpected error occurred');
  process.exit(1);
});

// Parse command line arguments
program.parse();

// Show help if no command is provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
