import React, { useState, useEffect } from 'react';
import Helmet from 'react-helmet';
import HttpsRequiredWarning from './components/HttpsRequiredWarning';
import OrderlyProvider from './components/OrderlyProvider';
import Outlet from './components/Outlet';
import OnboardingModal from './components'; // Ensure the correct path

const App = () => {
    const [showOnboarding, setShowOnboarding] = useState(
        localStorage.getItem('ntl_onboarded') === null
    );

    useEffect(() => {
        if (!localStorage.getItem('ntl_onboarded')) {
            setShowOnboarding(true);
        }
    }, []);

    const handleComplete = () => {
        localStorage.setItem('ntl_onboarded', 'true');
        setShowOnboarding(false);
    };

    const handleSkip = () => {
        localStorage.setItem('ntl_onboarded', 'true');
        setShowOnboarding(false);
    };

    return (
        <OrderlyProvider>
            <Helmet />
            <HttpsRequiredWarning />
            {showOnboarding && (
                <OnboardingModal onComplete={handleComplete} onSkip={handleSkip} />
            )}
            <Outlet />
        </OrderlyProvider>
    );
};

export default App;