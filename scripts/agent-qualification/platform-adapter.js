'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function linuxAdapter() {
  return Object.freeze({
    platform: 'linux',
    sandboxName: 'Bubblewrap',
    backend: 'linux-bubblewrap',
    terminationGuarantee: 'namespace_scoped',
    terminationScope: 'pid_namespace',
    survivorsPossible: false,
    completeDescendantTermination: true,
    fullNetworkIncludesHostAbstractUnixSockets: true,
    listener(port) {
      return commandOutput('ss', ['-H', '-ltnp', `sport = :${port}`]) || '';
    },
    survivorPattern(extraPattern) {
      return extraPattern
        ? `[b]wrap|freedom-sandbox-supervisor|${extraPattern}`
        : '[b]wrap|freedom-sandbox-supervisor';
    },
    hostBaseline(networkEnabled) {
      const sysctl = (name) => readText(`/proc/sys/${name.replace(/\./g, '/')}`);
      return {
        distribution: readText('/etc/os-release')
          ?.split('\n')
          .find((line) => line.startsWith('PRETTY_NAME='))
          ?.slice('PRETTY_NAME='.length)
          .replace(/"/g, ''),
        bubblewrap: commandOutput('bwrap', ['--version']),
        apparmor: commandOutput('dpkg-query', ['-W', '-f=${Version}', 'apparmor']),
        apparmorLabel: readText('/proc/self/attr/current'),
        apparmorRestrictUnprivilegedUserns: sysctl(
          'kernel.apparmor_restrict_unprivileged_userns'
        ),
        unprivilegedUsernsClone: sysctl('kernel.unprivileged_userns_clone'),
        maxUserNamespaces: sysctl('user.max_user_namespaces'),
        networkPermissionsEnabled: networkEnabled,
      };
    },
    assertAvailable(baseline) {
      if (!baseline.bubblewrap) {
        throw new Error('Bubblewrap is required on Linux but `bwrap --version` did not succeed');
      }
    },
    receiptMatches(receipt, state) {
      return Boolean(
        receipt &&
          receipt.state === state &&
          receipt.backend === this.backend &&
          receipt.terminationGuarantee === this.terminationGuarantee &&
          receipt.terminationScope === this.terminationScope &&
          receipt.survivorsPossible === this.survivorsPossible &&
          receipt.completeDescendantTermination === this.completeDescendantTermination &&
          receipt.sideEffects === 'unknown'
      );
    },
    ledgerReceiptMatches(receipt, state) {
      return Boolean(
        receipt &&
          receipt.state === state &&
          receipt.backend === this.backend &&
          receipt.terminationGuarantee === this.terminationGuarantee &&
          receipt.terminationScope === this.terminationScope &&
          receipt.sideEffects === 'unknown' &&
          receipt.survivorsPossible === undefined &&
          receipt.completeDescendantTermination === undefined
      );
    },
    signalMatches(signal) {
      return signal === 'SIGKILL';
    },
    approvedRuntimeMatches(executablePath) {
      return executablePath?.startsWith('/opt/freedom-toolchain/approved/');
    },
    runtimeWriteDenied(code) {
      return code === 'EROFS';
    },
    offlineNetworkErrorMatches(text) {
      return text.includes('net:ConnectionRefusedError');
    },
  });
}

function macosAdapter() {
  return Object.freeze({
    platform: 'darwin',
    sandboxName: 'Seatbelt',
    backend: 'macos-seatbelt',
    terminationGuarantee: 'best_effort',
    terminationScope: 'original_process_group',
    survivorsPossible: true,
    completeDescendantTermination: false,
    fullNetworkIncludesHostAbstractUnixSockets: false,
    listener(port) {
      return (
        commandOutput('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']) || ''
      );
    },
    survivorPattern(extraPattern) {
      return extraPattern
        ? '[s]andbox-exec.*freedom-seatbelt-|freedom-seatbelt-session|freedom-sandbox-supervisor|' +
            extraPattern
        : '[s]andbox-exec.*freedom-seatbelt-|freedom-seatbelt-session|freedom-sandbox-supervisor';
    },
    hostBaseline(networkEnabled) {
      return {
        productName: commandOutput('/usr/sbin/sysctl', ['-n', 'hw.model']),
        macosVersion: commandOutput('/usr/bin/sw_vers', ['-productVersion']),
        macosBuild: commandOutput('/usr/bin/sw_vers', ['-buildVersion']),
        sandboxExec: fs.existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : null,
        seatbeltInterface: 'deprecated-public-interface',
        networkPermissionsEnabled: networkEnabled,
      };
    },
    assertAvailable(baseline) {
      if (!baseline.sandboxExec) {
        throw new Error('Seatbelt is required on macOS but /usr/bin/sandbox-exec is unavailable');
      }
    },
    receiptMatches(receipt, state) {
      return Boolean(
        receipt &&
          receipt.state === state &&
          receipt.backend === this.backend &&
          receipt.terminationGuarantee === this.terminationGuarantee &&
          receipt.terminationScope === this.terminationScope &&
          receipt.survivorsPossible === this.survivorsPossible &&
          receipt.completeDescendantTermination === this.completeDescendantTermination &&
          receipt.sideEffects === 'unknown'
      );
    },
    ledgerReceiptMatches(receipt, state) {
      return Boolean(
        receipt &&
          receipt.state === state &&
          receipt.backend === this.backend &&
          receipt.terminationGuarantee === this.terminationGuarantee &&
          receipt.terminationScope === this.terminationScope &&
          receipt.sideEffects === 'unknown' &&
          receipt.survivorsPossible === undefined &&
          receipt.completeDescendantTermination === undefined
      );
    },
    signalMatches(signal) {
      return signal === 'SIGTERM' || signal === 'SIGKILL';
    },
    approvedRuntimeMatches(executablePath) {
      const configured = process.env.npm_node_execpath;
      if (!configured) return path.isAbsolute(executablePath || '');
      try {
        return executablePath === fs.realpathSync(configured);
      } catch {
        return executablePath === configured;
      }
    },
    runtimeWriteDenied(code) {
      return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
    },
    offlineNetworkErrorMatches(text) {
      return text.includes('net:PermissionError');
    },
  });
}

function createPlatformAdapter(platform = process.platform) {
  if (platform === 'linux') return linuxAdapter();
  if (platform === 'darwin') return macosAdapter();
  return null;
}

function commonHostBaseline(adapter, networkEnabled) {
  return {
    platform: process.platform,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    user: os.userInfo().username,
    kernel: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    electron: process.versions.electron || null,
    ...adapter.hostBaseline(networkEnabled),
  };
}

module.exports = { createPlatformAdapter, commonHostBaseline };
