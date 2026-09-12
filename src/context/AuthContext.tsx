import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { HostUser } from '../types';
import { authService, AuthResult } from '../services/authService';

interface AuthContextType {
  user: HostUser | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password?: string) => Promise<AuthResult>;
  register: (email: string, fullName: string, password?: string, role?: 'couple' | 'planner', companyName?: string) => Promise<AuthResult>;
  loginWithDemo: (demoUser: HostUser) => Promise<AuthResult>;
  updateProfile: (fullName: string) => Promise<AuthResult>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<HostUser | null>(() => authService.getUser());
  const [token, setToken] = useState<string | null>(() => authService.getToken());

  useEffect(() => {
    const unsub = authService.subscribe(() => {
      setUser(authService.getUser());
      setToken(authService.getToken());
    });
    return unsub;
  }, []);

  const login = async (email: string, password?: string) => {
    return authService.login(email, password);
  };

  const register = async (email: string, fullName: string, password?: string, role: 'couple' | 'planner' = 'couple', companyName?: string) => {
    return authService.register(email, fullName, password, role, companyName);
  };

  const loginWithDemo = async (demoUser: HostUser) => {
    return authService.loginWithDemo(demoUser);
  };

  const updateProfile = async (fullName: string) => {
    return authService.updateProfile(fullName);
  };

  const logout = () => {
    authService.logout();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user && !!token,
        login,
        register,
        loginWithDemo,
        updateProfile,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
