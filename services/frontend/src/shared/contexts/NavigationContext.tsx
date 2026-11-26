import React, { createContext, useContext, useState } from 'react';
import type { NavGroup } from '@shared/types/navigation';

interface NavigationContextType {
  isVisible: boolean;
  hideNavigation: () => void;
  showNavigation: () => void;
  navGroups?: NavGroup[];
}

const NavigationContext = createContext<NavigationContextType | undefined>(undefined);

export const NavigationProvider: React.FC<{ children: React.ReactNode; navGroups?: NavGroup[] }> = ({
  children,
  navGroups,
}) => {
  const [isVisible, setIsVisible] = useState(true);

  const hideNavigation = () => setIsVisible(false);
  const showNavigation = () => setIsVisible(true);

  return (
    <NavigationContext.Provider value={{ isVisible, hideNavigation, showNavigation, navGroups }}>
      {children}
    </NavigationContext.Provider>
  );
};

export const useNavigation = () => {
  const context = useContext(NavigationContext);
  if (context === undefined) {
    throw new Error('useNavigation must be used within a NavigationProvider');
  }
  return context;
};
