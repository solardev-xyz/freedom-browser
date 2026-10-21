// Owned hosted-runner compatibility experiment, not a production backend.
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <initguid.h>
#include <fwpmu.h>
#include <userenv.h>
#include <aclapi.h>
#include <rpc.h>
#include <sddl.h>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <algorithm>
#include <cwctype>

static void checked(bool success, const char* name) {
    if (!success) {
        std::printf("%s failed: %lu\n", name, GetLastError());
        throw std::runtime_error(name);
    }
}
struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};

static bool package_access(HANDLE token, const std::wstring& sid) {
    // AccessCheck measures the documented LPAC distinction without relying on
    // TokenIsLessPrivilegedAppContainer, which some user-mode kernels reject.
    Handle impersonation;
    checked(DuplicateToken(token, SecurityImpersonation, &impersonation.value) != 0, "DuplicateToken for package access");
    const std::wstring sddl = L"O:SYG:SYD:(A;;CC;;;WD)(A;;CC;;;" + sid + L")";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0,
        "Package access descriptor");
    GENERIC_MAPPING mapping = {FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS};
    std::vector<BYTE> privileges(1024);
    DWORD length = static_cast<DWORD>(privileges.size()), granted = 0;
    BOOL allowed = FALSE;
    const BOOL queried = AccessCheck(descriptor, impersonation.value, 1, &mapping,
        reinterpret_cast<PRIVILEGE_SET*>(privileges.data()), &length, &granted, &allowed);
    LocalFree(descriptor);
    checked(queried != 0, "Measure package access");
    return allowed != FALSE;
}
struct PackageFilter {
    HANDLE engine = nullptr;
    ~PackageFilter() { if (engine) FwpmEngineClose0(engine); }
    void install(PSID sid) {
        FWPM_SESSION0 session = {};
        session.flags = FWPM_SESSION_FLAG_DYNAMIC;
        DWORD status = FwpmEngineOpen0(nullptr, RPC_C_AUTHN_DEFAULT, nullptr, &session, &engine);
        if (status) { std::printf("Package filter engine error: %lu\n", status); throw std::runtime_error("Package filter engine"); }
        FWPM_SUBLAYER0 sublayer = {};
        const auto sublayer_uuid = UuidCreate(&sublayer.subLayerKey);
        checked(sublayer_uuid == RPC_S_OK || sublayer_uuid == RPC_S_UUID_LOCAL_ONLY, "Package sublayer UUID");
        sublayer.displayData.name = const_cast<wchar_t*>(L"Freedom owned package DNS fixture");
        sublayer.weight = 0xffff;
        status = FwpmSubLayerAdd0(engine, &sublayer, nullptr);
        if (status) throw std::runtime_error("Package filter sublayer");
        for (const auto& layer : {FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6}) {
            FWPM_FILTER_CONDITION0 condition = {};
            condition.fieldKey = FWPM_CONDITION_ALE_PACKAGE_ID;
            condition.matchType = FWP_MATCH_EQUAL;
            condition.conditionValue.type = FWP_SID;
            condition.conditionValue.sid = static_cast<SID*>(sid);
            FWPM_FILTER0 filter = {};
            const auto filter_uuid = UuidCreate(&filter.filterKey);
            checked(filter_uuid == RPC_S_OK || filter_uuid == RPC_S_UUID_LOCAL_ONLY, "Package filter UUID");
            filter.displayData.name = const_cast<wchar_t*>(L"Freedom owned offline package filter");
            filter.layerKey = layer;
            filter.subLayerKey = sublayer.subLayerKey;
            filter.action.type = FWP_ACTION_BLOCK;
            filter.numFilterConditions = 1;
            filter.filterCondition = &condition;
            UINT64 id = 0;
            status = FwpmFilterAdd0(engine, &filter, nullptr, &id);
            if (status) { std::printf("Package filter add error: %lu\n", status); throw std::runtime_error("Package filter add"); }
            FWPM_FILTER0* actual = nullptr;
            status = FwpmFilterGetById0(engine, id, &actual);
            if (status) throw std::runtime_error("Package filter readback");
            const bool valid = actual->numFilterConditions == 1 && actual->action.type == FWP_ACTION_BLOCK &&
                IsEqualGUID(actual->layerKey, layer) && IsEqualGUID(actual->subLayerKey, sublayer.subLayerKey) &&
                IsEqualGUID(actual->filterCondition[0].fieldKey, FWPM_CONDITION_ALE_PACKAGE_ID) &&
                actual->filterCondition[0].matchType == FWP_MATCH_EQUAL &&
                actual->filterCondition[0].conditionValue.type == FWP_SID &&
                EqualSid(actual->filterCondition[0].conditionValue.sid, sid);
            FwpmFreeMemory0(reinterpret_cast<void**>(&actual));
            if (!valid) throw std::runtime_error("Package filter readback mismatch");
        }
        std::puts("Verified exact package SID socket filters for IPv4 and IPv6");
    }
};
struct Profile {
    std::wstring name;
    PSID sid = nullptr;
    bool remove() {
        if (!sid) return true;
        const HRESULT status = DeleteAppContainerProfile(name.c_str());
        if (FAILED(status)) {
            std::printf("Owned profile deletion failed: 0x%08lx\n", static_cast<unsigned long>(status));
            return false;
        }
        FreeSid(sid); sid = nullptr;
        return true;
    }
    ~Profile() {
        if (sid && !remove()) FreeSid(sid);
    }
};
struct AclGrant {
    std::wstring path;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL original = nullptr;
    bool applied = false;
    AclGrant(const std::wstring& target, PSID sid, DWORD rights, DWORD inheritance) : path(target) {
        const DWORD read = GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            nullptr, nullptr, &original, nullptr, &descriptor);
        if (read) throw std::runtime_error("Cannot capture owned fixture ACL");
        EXPLICIT_ACCESS_W entry = {};
        entry.grfAccessPermissions = rights;
        entry.grfAccessMode = GRANT_ACCESS;
        entry.grfInheritance = inheritance;
        entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
        entry.Trustee.ptstrName = static_cast<LPWSTR>(sid);
        PACL updated = nullptr;
        DWORD result = SetEntriesInAclW(1, &entry, original, &updated);
        if (!result) result = SetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION, nullptr, nullptr, updated, nullptr);
        if (updated) LocalFree(updated);
        if (result) { LocalFree(descriptor); descriptor = nullptr; throw std::runtime_error("Cannot grant owned fixture ACL"); }
        applied = true;
    }
    bool restore() {
        if (!applied) return true;
        const DWORD status = SetNamedSecurityInfoW(path.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            nullptr, nullptr, original, nullptr);
        applied = status != ERROR_SUCCESS;
        if (status) std::printf("Owned ACL restoration failed: %lu\n", status);
        return !applied;
    }
    ~AclGrant() { restore(); if (descriptor) LocalFree(descriptor); }
};
struct Attributes {
    std::vector<BYTE> bytes;
    LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
    explicit Attributes(DWORD count) {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, count, 0, &size);
        bytes.resize(size);
        value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(bytes.data());
        checked(InitializeProcThreadAttributeList(value, count, 0, &size) != 0, "InitializeProcThreadAttributeList");
    }
    ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
};

static std::wstring quote(const std::wstring& text) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t character : text) {
        if (character == L'\\') { slashes++; continue; }
        result.append(slashes * (character == L'\"' ? 2 : 1), L'\\');
        if (character == L'\"') result.push_back(L'\\');
        result.push_back(character);
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L"\"";
}

int wmain(int argc, wchar_t** argv) {
    try {
        wchar_t github[8] = {};
        checked(GetEnvironmentVariableW(L"GITHUB_ACTIONS", github, 8) != 0 && !wcscmp(github, L"true"), "Disposable CI guard");
        if (argc != 4 && !(argc == 5 && (!wcscmp(argv[4], L"package-filter") || !wcscmp(argv[4], L"lpac"))))
            throw std::runtime_error("Expected node path, owned workspace and fixed probe source");
        const bool lpac = argc == 5 && !wcscmp(argv[4], L"lpac");
        const auto node = std::filesystem::canonical(argv[1]);
        const auto workspace = std::filesystem::canonical(argv[2]);
        auto owned = workspace.parent_path().wstring();
        std::transform(owned.begin(), owned.end(), owned.begin(), [](wchar_t value) { return static_cast<wchar_t>(std::towlower(value)); });
        if (owned.find(L"c:\\freedom-agent-tests\\freedom-dns-rpc-") != 0 ||
            node.parent_path().parent_path() != workspace.parent_path() || node.filename() != L"node.exe")
            throw std::runtime_error("Expected owned fixture paths");
        Profile profile;
        UUID uuid;
        const auto uuid_status = UuidCreate(&uuid);
        checked(uuid_status == RPC_S_OK || uuid_status == RPC_S_UUID_LOCAL_ONLY, "UuidCreate");
        RPC_WSTR uuid_text = nullptr;
        checked(UuidToStringW(&uuid, &uuid_text) == RPC_S_OK, "UuidToStringW");
        profile.name = L"freedom-dns-probe-" + std::wstring(reinterpret_cast<wchar_t*>(uuid_text));
        RpcStringFreeW(&uuid_text);
        const HRESULT created = CreateAppContainerProfile(profile.name.c_str(), L"Freedom owned DNS fixture",
            L"Disposable CI-only network isolation probe", nullptr, 0, &profile.sid);
        if (FAILED(created)) { std::printf("CreateAppContainerProfile: 0x%08lx\n", static_cast<unsigned long>(created)); throw std::runtime_error("AppContainer profile"); }
        PackageFilter package_filter;
        if (argc == 5 && !lpac) package_filter.install(profile.sid);

        std::vector<std::unique_ptr<AclGrant>> grants;
        // Never modify C:\ or the hosted Node installation. An inability to
        // traverse those defaults is a compatibility result, not an ACL grant.
        grants.push_back(std::make_unique<AclGrant>(workspace.parent_path().wstring(), profile.sid,
            FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL | SYNCHRONIZE, NO_INHERITANCE));
        grants.push_back(std::make_unique<AclGrant>(node.parent_path().wstring(), profile.sid,
            GENERIC_READ | GENERIC_EXECUTE, SUB_CONTAINERS_AND_OBJECTS_INHERIT));
        grants.push_back(std::make_unique<AclGrant>(workspace.wstring(), profile.sid,
            GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | DELETE, SUB_CONTAINERS_AND_OBJECTS_INHERIT));

        Handle job;
        job.value = CreateJobObjectW(nullptr, nullptr);
        checked(job.value != nullptr, "CreateJobObjectW");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        checked(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0, "SetInformationJobObject");
        SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
        Handle input;
        input.value = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
        checked(input.value != INVALID_HANDLE_VALUE, "Open NUL");
        HANDLE inherited[] = {input.value, GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
        for (const auto handle : inherited) checked(SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0, "SetHandleInformation");
        Attributes attributes(lpac ? 3 : 2);
        SECURITY_CAPABILITIES capabilities = {profile.sid, nullptr, 0, 0};
        checked(UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &capabilities, sizeof(capabilities), nullptr, nullptr) != 0, "Set AppContainer capabilities");
        checked(UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            inherited, sizeof(inherited), nullptr, nullptr) != 0, "Set inherited handles");
        DWORD package_policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
        if (lpac) checked(UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
            &package_policy, sizeof(package_policy), nullptr, nullptr) != 0, "Set LPAC policy");
        STARTUPINFOEXW startup = {};
        startup.StartupInfo.cb = static_cast<DWORD>(sizeof(startup));
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = inherited[0]; startup.StartupInfo.hStdOutput = inherited[1]; startup.StartupInfo.hStdError = inherited[2];
        startup.StartupInfo.lpDesktop = const_cast<wchar_t*>(L"winsta0\\default");
        startup.lpAttributeList = attributes.value;
        const std::wstring command = quote(node.wstring()) + L" -e " + quote(argv[3]);
        std::vector<wchar_t> command_buffer(command.begin(), command.end()); command_buffer.push_back(0);
        wchar_t system_root[MAX_PATH] = {};
        checked(GetEnvironmentVariableW(L"SystemRoot", system_root, MAX_PATH) != 0, "SystemRoot");
        wchar_t local_data[32768] = {};
        const DWORD local_data_length = GetEnvironmentVariableW(L"LOCALAPPDATA", local_data, 32768);
        checked(local_data_length != 0 && local_data_length < 32768, "AppContainer profile environment");
        std::wstring environment;
        // Windows resolves the newly registered profile through LOCALAPPDATA
        // during CreateProcess; inherit only that required path, never secrets.
        for (const auto& entry : {L"APPDATA=" + workspace.wstring(), L"HOME=" + workspace.wstring(),
            L"LOCALAPPDATA=" + std::wstring(local_data), L"PATH=" + node.parent_path().wstring(), L"SystemRoot=" + std::wstring(system_root),
            L"TEMP=" + workspace.wstring(), L"TMP=" + workspace.wstring(), L"USERPROFILE=" + workspace.wstring()}) {
            environment += entry; environment.push_back(0);
        }
        environment.push_back(0);
        PROCESS_INFORMATION process = {};
        checked(CreateProcessW(node.c_str(), command_buffer.data(), nullptr, nullptr, TRUE,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.data(), workspace.c_str(), &startup.StartupInfo, &process) != 0, "CreateProcessW(AppContainer)");
        Handle child; child.value = process.hProcess;
        Handle thread; thread.value = process.hThread;
        if (!AssignProcessToJobObject(job.value, child.value)) { TerminateProcess(child.value, 1); throw std::runtime_error("AssignProcessToJobObject"); }
        Handle token;
        checked(OpenProcessToken(child.value, TOKEN_QUERY | TOKEN_DUPLICATE, &token.value) != 0, "OpenProcessToken");
        DWORD appcontainer = 0, returned = 0;
        checked(GetTokenInformation(token.value, TokenIsAppContainer, &appcontainer, sizeof(appcontainer), &returned) != 0 && appcontainer == 1,
            "Verify actual AppContainer token");
        DWORD token_size = 0;
        GetTokenInformation(token.value, TokenCapabilities, nullptr, 0, &token_size);
        if (token_size < sizeof(DWORD) || token_size > 65536) throw std::runtime_error("Unexpected token capabilities");
        std::vector<BYTE> token_bytes(token_size);
        checked(GetTokenInformation(token.value, TokenCapabilities, token_bytes.data(), token_size, &returned) != 0,
            "Read actual token capabilities");
        if (reinterpret_cast<TOKEN_GROUPS*>(token_bytes.data())->GroupCount != 0)
            throw std::runtime_error("AppContainer inherited capabilities");
        GetTokenInformation(token.value, TokenAppContainerSid, nullptr, 0, &token_size);
        if (token_size < sizeof(TOKEN_APPCONTAINER_INFORMATION) || token_size > 65536) throw std::runtime_error("Unexpected package SID length");
        token_bytes.resize(token_size);
        checked(GetTokenInformation(token.value, TokenAppContainerSid, token_bytes.data(), token_size, &returned) != 0 &&
            EqualSid(profile.sid, reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(token_bytes.data())->TokenAppContainer) != 0,
            "Verify expected AppContainer SID");
        LPWSTR package_sid_text = nullptr;
        checked(ConvertSidToStringSidW(profile.sid, &package_sid_text) != 0, "Package SID text");
        const bool explicit_access = package_access(token.value, package_sid_text);
        LocalFree(package_sid_text);
        checked(explicit_access && package_access(token.value, L"S-1-15-2-1") == !lpac, "Verify package access semantics");
        if (lpac) std::puts("Verified less-privileged AppContainer access semantics");
        std::puts("Verified AppContainer process, zero network capabilities"); std::fflush(stdout);
        checked(ResumeThread(thread.value) != static_cast<DWORD>(-1), "ResumeThread");
        if (WaitForSingleObject(child.value, 10000) != WAIT_OBJECT_0) {
            TerminateJobObject(job.value, 1); WaitForSingleObject(child.value, 5000);
            throw std::runtime_error("AppContainer probe timeout");
        }
        DWORD exit_code = 1;
        checked(GetExitCodeProcess(child.value, &exit_code) != 0, "GetExitCodeProcess");
        std::printf("AppContainer workload exit: %lu\n", exit_code);
        checked(TerminateJobObject(job.value, 0) != 0, "Terminate completed probe job");
        bool drained = false;
        for (unsigned i = 0; i < 500; i++) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {};
            checked(QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting,
                sizeof(accounting), nullptr) != 0, "Query probe job");
            if (!accounting.ActiveProcesses) { drained = true; break; }
            Sleep(10);
        }
        if (!drained) throw std::runtime_error("Owned probe descendants did not drain");
        bool restored = true;
        while (!grants.empty()) { restored = grants.back()->restore() && restored; grants.pop_back(); }
        const bool profile_removed = profile.remove();
        return exit_code == 0 && restored && profile_removed ? 0 : 1;
    } catch (const std::exception& error) {
        std::printf("AppContainer probe failed: %s\n", error.what());
        return 1;
    }
}
