import {Command} from 'commander';
import path from 'path';
import fs from 'fs';
import {execSync} from 'child_process';
import chalk from 'chalk';
import {createRequire} from 'module';
import readline from 'readline';

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Promise-based prompt function
const promptUser = (question: string) => {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer);
    });
  });
};

export const deployCommand = new Command('deploy')
  .description('Deploy a Tonk app to EC2')
  .option('-i, --instance <address>', 'EC2 instance address')
  .option('-k, --key <path>', 'Path to SSH key file')
  .option('-u, --user <name>', 'SSH username', 'ec2-user')
  .option('-t, --token <token>', 'Pinggy.io access token')
  .option('-b, --backblaze', 'Enable Backblaze B2 storage for document backup')
  .action(async options => {
    const projectRoot = process.cwd();
    const configFilePath = path.join(projectRoot, 'tonk.config.json');

    // Check if config file exists
    if (!fs.existsSync(configFilePath)) {
      console.error(
        chalk.red(`
Error: No configuration file found at ${configFilePath}

Please run 'tonk config' first to set up your EC2 instance and create a configuration file.
You can provision a new EC2 instance with 'tonk config --provision' or configure an existing one.
        `),
      );
      process.exit(1);
    }

    // Load settings from config file
    let configData;
    try {
      configData = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));

      // Use config values as defaults if not provided in command options
      if (!options.instance && configData.ec2 && configData.ec2.instance) {
        options.instance = configData.ec2.instance;
        console.log(
          chalk.blue(`Using EC2 instance from config: ${options.instance}`),
        );
      }

      if (!options.key && configData.ec2 && configData.ec2.keyPath) {
        options.key = configData.ec2.keyPath;
        console.log(chalk.blue(`Using SSH key from config: ${options.key}`));
      }

      if (!options.user && configData.ec2 && configData.ec2.user) {
        options.user = configData.ec2.user;
        console.log(chalk.blue(`Using SSH user from config: ${options.user}`));
      }

      // Check for Pinggy token in config
      if (!options.token && configData.pinggy && configData.pinggy.token) {
        options.token = configData.pinggy.token;
        console.log(chalk.blue(`Using Pinggy token from config`));
      }

      // Check if Backblaze is already configured
      if (configData.backblaze && configData.backblaze.enabled) {
        options.backblaze = true;
        console.log(chalk.blue(`Backblaze B2 backup enabled from config`));
      }
    } catch (error) {
      console.error(
        chalk.red(
          `Error: Could not parse config file at ${configFilePath}. Please run 'tonk config' again.`,
        ),
      );
      process.exit(1);
    }

    // Verify required options are present after loading from config
    if (!options.instance) {
      console.error(
        chalk.red(
          'Error: EC2 instance address not found in config file and not provided as an option.',
        ),
      );
      console.error(chalk.yellow("Please run 'tonk config' again."));
      process.exit(1);
    }

    if (!options.key || !fs.existsSync(options.key)) {
      console.error(
        chalk.red(
          'Error: Valid SSH key file path not found in config file and not provided as an option.',
        ),
      );
      console.error(chalk.yellow("Please run 'tonk config' again."));
      process.exit(1);
    }

    // Set up Backblaze if requested and not already configured
    if (
      options.backblaze &&
      (!configData.backblaze || !configData.backblaze.enabled)
    ) {
      console.log(
        chalk.blue('Setting up Backblaze B2 backup for Automerge documents...'),
      );

      // Ask for Backblaze credentials
      const useBackblaze = await promptUser(
        chalk.yellow(
          'Do you want to enable Backblaze B2 backup for your document data? (yes/no): ',
        ),
      );

      if ((useBackblaze as string).toLowerCase().startsWith('y')) {
        const b2KeyId = await promptUser(
          chalk.yellow('Enter your Backblaze B2 Application Key ID: '),
        );
        const b2Key = await promptUser(
          chalk.yellow('Enter your Backblaze B2 Application Key: '),
        );
        const b2BucketId = await promptUser(
          chalk.yellow('Enter your Backblaze B2 Bucket ID: '),
        );
        const b2BucketName = await promptUser(
          chalk.yellow('Enter your Backblaze B2 Bucket Name: '),
        );

        // Update config
        configData.backblaze = {
          enabled: true,
          applicationKeyId: b2KeyId,
          applicationKey: b2Key,
          bucketId: b2BucketId,
          bucketName: b2BucketName,
          syncInterval: 5 * 60 * 1000, // 5 minutes default
          maxRetries: 3,
        };

        // Save updated config
        fs.writeFileSync(
          configFilePath,
          JSON.stringify(configData, null, 2),
          'utf8',
        );
        console.log(chalk.green('Backblaze B2 configuration saved'));
      } else {
        options.backblaze = false;
      }
    }

    // If backblaze option wasn't explicitly set
    // ask the user if they want to enable it
    if (options.backblaze === undefined) {
      const enableBackblaze = await promptUser(
        chalk.yellow(
          'Would you like to enable Backblaze B2 backup for your document data? (yes/no): ',
        ),
      );

      options.backblaze = (enableBackblaze as string)
        .toLowerCase()
        .startsWith('y');

      if (options.backblaze) {
        console.log(chalk.green('Backblaze B2 backup will be enabled'));
      } else {
        console.log(chalk.blue('Backblaze B2 backup will not be enabled'));
      }
    }

    try {
      // 1. Build the application
      console.log(chalk.blue('Building application...'));
      execSync('npm run build', {cwd: projectRoot, stdio: 'inherit'});

      // 2. Copy Dockerfile if it doesn't exist
      const dockerfilePath = path.join(projectRoot, 'Dockerfile');
      if (!fs.existsSync(dockerfilePath)) {
        const require = createRequire(import.meta.url);

        const templatePath = path.join(
          require.resolve('@tonk/server/package.json'),
          '..',
          'templates',
          'Dockerfile',
        );
        fs.copyFileSync(templatePath, dockerfilePath);
        console.log(chalk.green('Created Dockerfile from template'));
      }

      // 3. Package the application
      console.log(chalk.blue('Packaging application...'));

      // Create a tarball
      const packOutput = execSync('npm pack', {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();

      // npm pack creates a file with a name like: package-name-version.tgz
      const npmPackageFile = path.join(projectRoot, packOutput);
      const tarFileName = 'tonk-app.tgz';
      const tarFilePath = path.join(projectRoot, tarFileName);

      // Rename the npm package to our standard name
      if (fs.existsSync(tarFilePath)) {
        fs.unlinkSync(tarFilePath);
      }
      fs.renameSync(npmPackageFile, tarFilePath);

      // 4. Copy to EC2
      console.log(chalk.blue(`Copying to EC2 instance ${options.instance}...`));
      execSync(
        `scp -i "${options.key}" "${tarFileName}" ${options.user}@${options.instance}:~/`,
        {cwd: projectRoot, stdio: 'inherit'},
      );

      // If Backblaze is configured, copy the config too
      if (options.backblaze) {
        execSync(
          `scp -i "${options.key}" "${configFilePath}" ${options.user}@${options.instance}:~/tonk-app/tonk.config.json`,
          {cwd: projectRoot, stdio: 'inherit'},
        );
      }

      // 5. SSH into EC2 and deploy with Docker
      console.log(chalk.blue('Deploying on EC2...'));

      // Build the Docker run command with environment variables for Backblaze if configured
      let dockerRunCmd =
        'docker run -d --name tonk-app-container -p 8080:8080 -e PORT=8080';

      // Add Backblaze environment variables if enabled
      if (
        options.backblaze &&
        configData.backblaze &&
        configData.backblaze.enabled
      ) {
        dockerRunCmd += ` -e BACKBLAZE_ENABLED=true`;
        dockerRunCmd += ` -e BACKBLAZE_APP_KEY_ID='${configData.backblaze.applicationKeyId}'`;
        dockerRunCmd += ` -e BACKBLAZE_APP_KEY='${configData.backblaze.applicationKey}'`;
        dockerRunCmd += ` -e BACKBLAZE_BUCKET_ID='${configData.backblaze.bucketId}'`;
        dockerRunCmd += ` -e BACKBLAZE_BUCKET_NAME='${configData.backblaze.bucketName}'`;
        dockerRunCmd += ` -e BACKBLAZE_SYNC_INTERVAL='${configData.backblaze.syncInterval || 300000}'`;
      }

      dockerRunCmd += ' tonk-app';

      const sshCommand = `ssh -i "${options.key}" ${options.user}@${options.instance} '
        mkdir -p tonk-app &&
        tar -xzf ${tarFileName} -C tonk-app --strip-components=1 &&
        cd tonk-app &&
        docker build -t tonk-app . &&
        docker stop tonk-app-container || true &&
        docker rm tonk-app-container || true &&
        ${dockerRunCmd} &&
        sudo systemctl restart nginx.service
      '`;

      execSync(sshCommand, {cwd: projectRoot, stdio: 'inherit'});

      // 6. Clean up
      fs.unlinkSync(tarFilePath);

      console.log(
        chalk.green(`
✅ Deployment successful!
Your app is now running at http://${options.instance}
      `),
      );

      // Print Backblaze info if enabled
      if (
        options.backblaze &&
        configData.backblaze &&
        configData.backblaze.enabled
      ) {
        console.log(
          chalk.green(`
Backblaze B2 backup is enabled for your Automerge documents.
Documents will be synced to your B2 bucket: ${configData.backblaze.bucketName}
          `),
        );
      }

      // 7. Set up reverse proxy with pinggy.io
      console.log(
        chalk.blue('Setting up secure public access via pinggy.io...'),
      );

      // Prompt user for Pinggy token if not provided
      if (!options.token) {
        console.log(
          chalk.yellow(`
No Pinggy.io access token found. You'll need a token to create a secure public URL.
`),
        );

        options.token = await promptUser(
          chalk.yellow(
            'Please enter your Pinggy.io access token (or visit https://pinggy.io/ to sign up): ',
          ),
        );

        if (!options.token.trim()) {
          console.log(
            chalk.yellow(`
No token provided. Skipping public URL setup.
You can manually set up a tunnel later by SSH-ing into your EC2 instance.
          `),
          );
          rl.close();
          return;
        }

        // Ask if user wants to save the token in config
        const saveToken = await promptUser(
          chalk.yellow(
            'Would you like to save this token in your tonk.config.json for future deployments? (yes/no): ',
          ),
        );

        if ((saveToken as string).toLowerCase().startsWith('y')) {
          try {
            const configData = JSON.parse(
              fs.readFileSync(configFilePath, 'utf8'),
            );
            configData.pinggy = configData.pinggy || {};
            configData.pinggy.token = options.token;
            fs.writeFileSync(
              configFilePath,
              JSON.stringify(configData, null, 2),
              'utf8',
            );
            console.log(chalk.green('Token saved to configuration file.'));
          } catch (error) {
            console.log(
              chalk.yellow(
                `Could not save token to config file: ${(error as Error).message}`,
              ),
            );
          }
        }
      }

      try {
        // Run the pinggy.io command on the EC2 instance with user's token
        const pinggySetupCommand = `ssh -i "${options.key}" ${options.user}@${options.instance} '
          # Kill any existing pinggy sessions
          screen -ls | grep pinggy && screen -S pinggy -X quit || true
          
          # Start a new detached screen session for the pinggy tunnel
          screen -dmS pinggy bash -c "ssh -p 443 -R0:localhost:8080 -L4300:localhost:4300 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 ${options.token}@pro.pinggy.io x:https 2>&1 | tee /tmp/pinggy.log"
          
          # Wait for the URL to appear in the log
          echo "Waiting for pinggy.io to establish connection..."
          timeout=30
          while [ $timeout -gt 0 ] && ! grep -q "https://" /tmp/pinggy.log; do
            sleep 1
            timeout=$((timeout-1))
          done
          
          # Extract and display the URL
          if grep -q "https://" /tmp/pinggy.log; then
            grep -o "https://[^ ]*" /tmp/pinggy.log
            echo "Tunnel is running in the background. To view logs: screen -r pinggy"
            echo "To terminate: screen -S pinggy -X quit"
          else
            echo "Timed out waiting for pinggy.io URL"
            cat /tmp/pinggy.log
          fi
        '`;

        const pinggyOutput = execSync(pinggySetupCommand, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Extract the HTTPS URL from the output
        const urlMatch = pinggyOutput.match(/https:\/\/[^\s"']+/);
        const publicUrl = urlMatch ? urlMatch[0] : null;

        if (publicUrl) {
          console.log(
            chalk.green(`
🌐 Public access URL:
${publicUrl}

This URL will remain active as long as the EC2 instance is running.
The tunnel is running in a detached screen session on your EC2 instance.

To view tunnel logs: ssh into your EC2 instance and run 'screen -r pinggy'
To terminate the tunnel: ssh into your EC2 instance and run 'screen -S pinggy -X quit'
            `),
          );
        } else {
          console.log(
            chalk.yellow(`
Could not extract public URL from pinggy.io output.
The tunnel might still be running. SSH into your EC2 instance to check.

Output from setup command:
${pinggyOutput}
            `),
          );
        }
      } catch (error) {
        console.log(
          chalk.yellow(`
Note: Could not establish reverse proxy tunnel.
You can manually run the following command in the EC2 instance to create a public URL:

ssh -p 443 -R0:localhost:8080 -L4300:localhost:4300 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 YOUR_PINGGY_TOKEN@pro.pinggy.io x:https

Error details: ${error}
        `),
        );
      }

      // Close readline interface
      rl.close();
    } catch (error) {
      console.error(chalk.red('Deployment failed:'), error);
      // Make sure to close readline interface even on error
      rl.close();
      process.exit(1);
    }
  });
