const DEFAULT_USER_SETTINGS = {
    account: {
        rememberMeDefault: false
    },
    sharing: {
        defaultPermission: 'download',
        defaultExpiryMinutes: null,
        directLinkEnabled: true,
        directLinkPermission: 'download',
        directLinkExpiryMinutes: null
    },
    uploads: {
        autoResumeInterrupted: true,
        showRecoveryPanel: true,
        showUploadPanel: true
    },
    scanning: {
        showScanPanel: true,
        notifyOnComplete: true,
        scanSharedBeforeOpen: true
    },
    conversions: {
        pdfPreserveLayout: true,
        previewDpi: 144,
        mediaQuality: 'balanced',
        gifQuality: 'balanced'
    },
    workspace: {
        reopenLastPanels: false,
        enablePanelAnimations: true,
        dimInactivePanels: true,
        mobileNavAutoClose: true
    },
    notifications: {
        uploads: true,
        shares: true,
        scans: true,
        conversions: true,
        downloads: false
    }
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function pickBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function pickEnum(value, allowedValues, fallback) {
    return allowedValues.includes(value) ? value : fallback;
}

function pickInteger(value, fallback, min, max) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.max(min, Math.min(max, Math.round(number)));
}

function pickExpiryMinutes(value, fallback) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    return pickInteger(value, fallback, 1, 525600);
}

function normalizeUserSettings(settings = {}) {
    const input = isPlainObject(settings) ? settings : {};
    const defaults = clone(DEFAULT_USER_SETTINGS);
    const account = isPlainObject(input.account) ? input.account : {};
    const sharing = isPlainObject(input.sharing) ? input.sharing : {};
    const uploads = isPlainObject(input.uploads) ? input.uploads : {};
    const scanning = isPlainObject(input.scanning) ? input.scanning : {};
    const conversions = isPlainObject(input.conversions) ? input.conversions : {};
    const workspace = isPlainObject(input.workspace) ? input.workspace : {};
    const notifications = isPlainObject(input.notifications) ? input.notifications : {};

    return {
        account: {
            rememberMeDefault: pickBoolean(account.rememberMeDefault, defaults.account.rememberMeDefault)
        },
        sharing: {
            defaultPermission: pickEnum(sharing.defaultPermission, ['download', 'view'], defaults.sharing.defaultPermission),
            defaultExpiryMinutes: pickExpiryMinutes(sharing.defaultExpiryMinutes, defaults.sharing.defaultExpiryMinutes),
            directLinkEnabled: pickBoolean(sharing.directLinkEnabled, defaults.sharing.directLinkEnabled),
            directLinkPermission: pickEnum(sharing.directLinkPermission, ['download', 'view'], defaults.sharing.directLinkPermission),
            directLinkExpiryMinutes: pickExpiryMinutes(sharing.directLinkExpiryMinutes, defaults.sharing.directLinkExpiryMinutes)
        },
        uploads: {
            autoResumeInterrupted: pickBoolean(uploads.autoResumeInterrupted, defaults.uploads.autoResumeInterrupted),
            showRecoveryPanel: pickBoolean(uploads.showRecoveryPanel, defaults.uploads.showRecoveryPanel),
            showUploadPanel: pickBoolean(uploads.showUploadPanel, defaults.uploads.showUploadPanel)
        },
        scanning: {
            showScanPanel: pickBoolean(scanning.showScanPanel, defaults.scanning.showScanPanel),
            notifyOnComplete: pickBoolean(scanning.notifyOnComplete, defaults.scanning.notifyOnComplete),
            scanSharedBeforeOpen: pickBoolean(scanning.scanSharedBeforeOpen, defaults.scanning.scanSharedBeforeOpen)
        },
        conversions: {
            pdfPreserveLayout: pickBoolean(conversions.pdfPreserveLayout, defaults.conversions.pdfPreserveLayout),
            previewDpi: pickInteger(conversions.previewDpi, defaults.conversions.previewDpi, 72, 300),
            mediaQuality: pickEnum(conversions.mediaQuality, ['low', 'balanced', 'high', 'source'], defaults.conversions.mediaQuality),
            gifQuality: pickEnum(conversions.gifQuality, ['low', 'balanced', 'high', 'source'], defaults.conversions.gifQuality)
        },
        workspace: {
            reopenLastPanels: pickBoolean(workspace.reopenLastPanels, defaults.workspace.reopenLastPanels),
            enablePanelAnimations: pickBoolean(workspace.enablePanelAnimations, defaults.workspace.enablePanelAnimations),
            dimInactivePanels: pickBoolean(workspace.dimInactivePanels, defaults.workspace.dimInactivePanels),
            mobileNavAutoClose: pickBoolean(workspace.mobileNavAutoClose, defaults.workspace.mobileNavAutoClose)
        },
        notifications: {
            uploads: pickBoolean(notifications.uploads, defaults.notifications.uploads),
            shares: pickBoolean(notifications.shares, defaults.notifications.shares),
            scans: pickBoolean(notifications.scans, defaults.notifications.scans),
            conversions: pickBoolean(notifications.conversions, defaults.notifications.conversions),
            downloads: pickBoolean(notifications.downloads, defaults.notifications.downloads)
        }
    };
}

module.exports = {
    DEFAULT_USER_SETTINGS,
    normalizeUserSettings
};
